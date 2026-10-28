import { promises as fs } from 'fs';
import path from 'path';
import dockerCompose from 'docker-compose';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import docker from '../../utils/docker_client.js';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import DataService from '../../database/data_service.js';

const SNAPSHOT_PATTERN = /^update_\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}$/;
const IMAGES_PROPERTY = 'univrs:images';
const OVERRIDE_FILE = 'docker-compose.override.yml';

const getServiceImageDigests = async (dataset, snapshotName, title) => {
	const { stdout, exitCode } = await execa('zfs', ['get', '-H', '-o', 'value', IMAGES_PROPERTY, `${dataset}@${snapshotName}`], { reject: false });
	if (exitCode !== 0) {
		throw new Error(`${title} snapshot not found.`);
	}

	try {
		return JSON.parse(stdout.trim());
	} catch (error) {
		throw new Error(`${title} snapshot does not record its versions.`);
	}
};

const repositoryOf = (image) => {
	const reference = String(image ?? '').split('@')[0];
	const tagSeparator = reference.lastIndexOf(':');
	return (tagSeparator > reference.lastIndexOf('/') ? reference.slice(0, tagSeparator) : reference);
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

	if (!SNAPSHOT_PATTERN.test(snapshotName)) {
		throw new Error(`${title} can only be rolled back to the snapshot taken before an update.`);
	}

	const dataset = `${module.appsDataset}/${existingApp.name}`;
	const serviceImageDigests = await getServiceImageDigests(dataset, snapshotName, title);
	const containers = await module.findContainersByAppName(existingApp.name);
	const composeProject = containers[0]?.labels?.comDockerComposeProject || existingApp.name;
	const composeProjectDir = containers[0]?.labels?.comDockerComposeProjectWorkingDir || path.join(module.appsDir, composeProject, module.composeDir);
	const composeOptions = [['-p', composeProject]];

	await module.updateJobProgress(job, `Stopping ${title}...`);
	await stopContainers(containers);

	await module.updateJobProgress(job, `Rolling back ${title} data and settings...`);
	try {
		await rollbackDataset(dataset, snapshotName);
	} catch (error) {
		throw new Error(`Could not roll back ${title} data and settings.`);
	}

	const { data } = await dockerCompose.config({ cwd: composeProjectDir, composeOptions });
	const services = {};
	for (const [service, { image, digest }] of Object.entries(serviceImageDigests)) {
		const repository = repositoryOf(data.config?.services?.[service]?.image || image);
		if (repository && digest) {
			services[service] = { image: `${repository}@${digest}` };
		}
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
		await dockerCompose.upAll({
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
