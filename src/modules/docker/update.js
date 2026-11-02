import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import dockerCompose from 'docker-compose';
import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import docker from '../../utils/docker_client.js';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);
const SNAPSHOT_PREFIX = 'update_';
const IMAGES_PROPERTY = 'univrs:images';

const generateSnapshotName = () => {
	const now = new Date();
	const pad = (value) => { return String(value).padStart(2, '0'); };
	return `${SNAPSHOT_PREFIX}${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
};

const getServiceImageDigests = async (containers) => {
	const images = camelcaseKeys(await docker.listImages({ all: true, digests: true }), { deep: true });
	const result = {};
	for (const container of containers) {
		const image = images.find((image) => { return image.id === container.imageId; });
		const digest = image?.repoDigests?.[0]?.split('@')[1];
		if (digest) {
			result[container.labels?.comDockerComposeService] = { image: container.image, digest };
		}
	}
	return result;
};

const takeSnapshot = async (job, module, name, title, containers) => {
	const dataset = `${module.appsDataset}/${name}`;
	const snapshotName = generateSnapshotName();
	await module.updateJobProgress(job, `Taking ${title} snapshot...`);
	try {
		await execa('zfs', ['snapshot', '-r', '-o', `${IMAGES_PROPERTY}=${JSON.stringify(await getServiceImageDigests(containers))}`, `${dataset}@${snapshotName}`]);
	} catch (error) {
		throw new Error(`Could not take ${title} snapshot.`);
	}

	const { stdout } = await execa('zfs', ['list', '-t', 'snapshot', '-H', '-o', 'name', '-d', '1', dataset]);
	const previousSnapshots = stdout.split('\n').filter((line) => {
		const [, current] = line.split('@');
		return current?.startsWith(SNAPSHOT_PREFIX) && current !== snapshotName;
	});
	for (const previousSnapshot of previousSnapshots) {
		await execa('zfs', ['destroy', '-r', previousSnapshot]);
	}
};

const updateApp = async (job, module) => {
	const { config } = job.data;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const containers = await module.findContainersByAppName(config.name);
	if (containers.length === 0) {
		throw new Error(`Containers for app '${config.name}' not found.`);
	}
	
	const container = containers[0];
	const composeProject = container.labels?.comDockerComposeProject;
	const composeProjectDir = container.labels?.comDockerComposeProjectWorkingDir || path.join(module.appsDir, composeProject, module.composeDir);
	await module.updateJobProgress(job, `${existingApp.title} update starting...`);
	await takeSnapshot(job, module, config.name, existingApp.title, containers);
	const template = module.findTemplateByAppName(await module.getTemplates(), config.name);
	if (template) {
		try {
			const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
			if (response.ok) {
				const stack = await response.text();
				await module.updateJobProgress(job, `Writing ${template.title} project template...`);
				await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
				const icon = template.logo.split('/').pop();
				const responseIcon = await fetch(template.logo);
				if (responseIcon.ok) {
					await streamPipeline(responseIcon.body, createWriteStream(path.join(module.appIconsDir, icon)));
					const updatedApp = { ...existingApp, icon: icon, canEmbed: (typeof template.embed === 'boolean' ? template.embed : existingApp.canEmbed) };
					await DataService.setApplication(updatedApp);
					module.eventEmitter.emit('configured:updated');
				}
			}
		} catch (error) {}
	}

	await module.ensureAppDirEnv(composeProjectDir);
	await module.updateJobProgress(job, `Downloading ${existingApp.title}...`);
	const parsePullProgress = dockerPullProgressParser();
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', composeProject], ['--progress', 'json']],
		callback: (chunk) => {
			const progress = parsePullProgress(chunk);
			if (progress) {
				module.updateJobProgress(job, `Downloading ${existingApp.title}...`, progress);
			}
		}
	});
	await module.updateJobProgress(job, `Updating ${existingApp.title}...`);
	await module.upKeepingServiceStates(config.name, containers, {
		cwd: composeProjectDir,
		composeOptions: [['-p', composeProject]],
		commandOptions: ['--remove-orphans'],
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});

	await module.updateJobProgress(job, `Cleaning up...`);
	await docker.pruneImages();
	let updates = module.toArray(module.getState('updates')).filter((update) => {
		return !containers.some((container) => { return container.id === update.containerId; });
	});
	module.setState('updates', updates);
	module.eventEmitter.emit('app:updates:updated', module.getAppUpdatesSummary());
	module.emitState('updates');
	return `${existingApp.title} updated.`;
};

export default {
	name: 'update',
	commands: {
		'app:update': { job: 'app:update' }
	},
	jobs: {
		'app:update': (job, module) => {
			return module.withAppLock(job.data?.config?.name, async () => {
				try {
					return await updateApp(job, module);
				} finally {
					module.eventEmitter.emit('host:storage:snapshots:fetch');
				}
			});
		}
	}
};
