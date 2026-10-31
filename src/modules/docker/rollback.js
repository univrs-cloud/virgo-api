import { promises as fs } from 'fs';
import path from 'path';
import dockerCompose from 'docker-compose';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import docker from '../../utils/docker_client.js';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import DataService from '../../database/data_service.js';

const IMAGES_PROPERTY = 'univrs:images';
const OVERRIDE_FILE = 'docker-compose.override.yml';
const MANIFEST_ACCEPT = [
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
	'application/vnd.oci.image.manifest.v1+json'
].join(',');

const getServiceImageDigests = async (dataset, snapshotName, title) => {
	const { stdout, exitCode } = await execa('zfs', ['get', '-H', '-o', 'value', IMAGES_PROPERTY, `${dataset}@${snapshotName}`], { reject: false });
	if (exitCode !== 0) {
		throw new Error(`${title} snapshot not found.`);
	}

	let serviceImageDigests;
	try {
		serviceImageDigests = JSON.parse(stdout.trim());
	} catch (error) {
		throw new Error(`${title} was not rolled back: the snapshot has no record of the image versions the app ran then.`);
	}

	if (!serviceImageDigests || typeof serviceImageDigests !== 'object' || !Object.keys(serviceImageDigests).length) {
		throw new Error(`${title} was not rolled back: the snapshot has no record of the image versions the app ran then.`);
	}

	return serviceImageDigests;
};

const repositoryOf = (image) => {
	const reference = String(image ?? '').split('@')[0];
	const tagSeparator = reference.lastIndexOf(':');
	return (tagSeparator > reference.lastIndexOf('/') ? reference.slice(0, tagSeparator) : reference);
};

const parseRepository = (repository) => {
	let registry = 'registry-1.docker.io';
	let repoPath = repository;
	const firstSlash = repository.indexOf('/');
	if (firstSlash !== -1) {
		const firstPart = repository.slice(0, firstSlash);
		if (firstPart.includes('.') || firstPart.includes(':') || firstPart.toLowerCase() === 'localhost') {
			registry = firstPart;
			repoPath = repository.slice(firstSlash + 1);
		}
	}

	if (registry.toLowerCase() === 'docker.io') {
		registry = 'registry-1.docker.io';
	}

	if (registry === 'registry-1.docker.io' && !repoPath.includes('/')) {
		repoPath = `library/${repoPath}`;
	}

	return { registry, repoPath };
};

const discard = async (response) => {
	try {
		await response.arrayBuffer();
	} catch (error) {}
};

const isAvailable = async (repository, digest) => {
	const { registry, repoPath } = parseRepository(repository);
	const registryBase = `https://${registry}`;
	const headers = { Accept: MANIFEST_ACCEPT };
	const challengeResponse = await fetch(`${registryBase}/v2/`);
	await discard(challengeResponse);
	const wwwAuth = challengeResponse.headers.get('WWW-Authenticate') || '';
	if (challengeResponse.status === 401 && wwwAuth.toLowerCase().startsWith('bearer')) {
		const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
		const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);
		if (!realmMatch) {
			throw new Error(`No realm in WWW-Authenticate header from ${registry}`);
		}

		const tokenUrl = new URL(realmMatch[1]);
		if (serviceMatch) {
			tokenUrl.searchParams.set('service', serviceMatch[1]);
		}
		tokenUrl.searchParams.set('scope', `repository:${repoPath}:pull`);
		const tokenResponse = await fetch(tokenUrl.toString());
		if (!tokenResponse.ok) {
			await discard(tokenResponse);
			throw new Error(`HTTP ${tokenResponse.status} fetching a token from ${registry}`);
		}

		const { token, access_token } = await tokenResponse.json();
		if (token || access_token) {
			headers.Authorization = `Bearer ${token || access_token}`;
		}
	}

	const manifestResponse = await fetch(`${registryBase}/v2/${repoPath}/manifests/${digest}`, { method: 'HEAD', headers });
	await discard(manifestResponse);
	if (manifestResponse.status === 404) {
		return false;
	}

	if (!manifestResponse.ok) {
		throw new Error(`HTTP ${manifestResponse.status} fetching ${repository}@${digest}`);
	}

	return true;
};

const checkImages = async (services, title) => {
	const missing = [];
	for (const [service, { image }] of Object.entries(services)) {
		const [repository, digest] = image.split('@');
		let available;
		try {
			available = await isAvailable(repository, digest);
		} catch (error) {
			console.error(`Could not check ${image}: ${error.message}`);
			throw new Error(`${title} was not rolled back: could not check whether the ${service} version it ran then is still available.`);
		}

		if (!available) {
			missing.push(service);
		}
	}

	if (missing.length) {
		throw new Error(`${title} was not rolled back: the ${missing.join(', ')} ${(missing.length === 1 ? 'version' : 'versions')} it ran then ${(missing.length === 1 ? 'is' : 'are')} no longer available.`);
	}
};

const stopContainers = async (containers) => {
	for (const container of containers) {
		try {
			await docker.getContainer(container.id).stop();
		} catch (error) {
			if (error.statusCode !== 304) {
				throw error;
			}
		}
	}
};

const rollbackDataset = async (dataset, snapshotName) => {
	const { stdout } = await execa('zfs', ['list', '-t', 'snapshot', '-H', '-o', 'name', '-r', dataset]);
	const snapshots = stdout.split('\n').filter((line) => { return line.endsWith(`@${snapshotName}`); });
	for (const snapshot of snapshots) {
		await execa('zfs', ['rollback', '-r', snapshot]);
	}
};

const rollbackApp = async (job, module) => {
	const { config } = job.data;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const title = existingApp.title;
	const snapshotName = String(config?.snapshot ?? '');
	if (snapshotName === '') {
		throw new Error(`No snapshot was given to roll ${title} back to.`);
	}

	const dataset = `${module.appsDataset}/${existingApp.name}`;
	const serviceImageDigests = await getServiceImageDigests(dataset, snapshotName, title);
	const containers = await module.findContainersByAppName(existingApp.name);
	const composeProject = containers[0]?.labels?.comDockerComposeProject || existingApp.name;
	const composeProjectDir = containers[0]?.labels?.comDockerComposeProjectWorkingDir || path.join(module.appsDir, composeProject, module.composeDir);
	const composeOptions = [['-p', composeProject]];
	const snapshotComposeDir = path.join(path.dirname(composeProjectDir), '.zfs', 'snapshot', snapshotName, path.basename(composeProjectDir));
	try {
		await fs.access(path.join(snapshotComposeDir, 'docker-compose.yml'));
		await fs.access(path.join(snapshotComposeDir, '.env'));
	} catch (error) {
		throw new Error(`${title} was not rolled back: the snapshot does not hold its project files.`);
	}

	const { data } = await dockerCompose.config({ cwd: snapshotComposeDir, composeOptions });
	const services = {};
	for (const [service, { image, digest }] of Object.entries(serviceImageDigests)) {
		const repository = repositoryOf(data.config?.services?.[service]?.image || image);
		if (repository && digest) {
			services[service] = { image: `${repository}@${digest}` };
		}
	}

	await module.updateJobProgress(job, `Checking ${title} versions...`);
	await checkImages(services, title);

	await module.updateJobProgress(job, `Stopping ${title}...`);
	await stopContainers(containers);

	await module.updateJobProgress(job, `Rolling back ${title} data and settings...`);
	try {
		await rollbackDataset(dataset, snapshotName);
	} catch (error) {
		throw new Error(`Could not roll back ${title} data and settings.`);
	}

	const overrideFile = path.join(composeProjectDir, OVERRIDE_FILE);
	await fs.writeFile(overrideFile, yaml.dump({ services }), 'utf-8');
	try {
		await module.updateJobProgress(job, `Downloading ${title}...`);
		const parsePullProgress = dockerPullProgressParser();
		await dockerCompose.pullAll({
			cwd: composeProjectDir,
			composeOptions: [...composeOptions, ['--progress', 'json']],
			callback: (chunk) => {
				const progress = parsePullProgress(chunk);
				if (progress) {
					module.updateJobProgress(job, `Downloading ${title}...`, progress);
				}
			}
		});
		await module.updateJobProgress(job, `Starting ${title}...`);
		await module.upKeepingServiceStates(containers, {
			cwd: composeProjectDir,
			composeOptions,
			commandOptions: ['--force-recreate', '--remove-orphans'],
			callback: (chunk) => {
				module.updateJobProgress(job, chunk.toString());
			}
		});
	} finally {
		await fs.rm(overrideFile, { force: true });
	}

	return `${title} rolled back.`;
};

export default {
	name: 'rollback',
	commands: {
		'app:rollback': { job: 'app:rollback' }
	},
	jobs: {
		'app:rollback': (job, module) => {
			return module.withAppLock(job.data?.config?.name, async () => {
				try {
					return await rollbackApp(job, module);
				} finally {
					module.eventEmitter.emit('host:storage:snapshots:fetch');
				}
			});
		}
	}
};
