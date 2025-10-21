const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const camelcaseKeys = require('camelcase-keys').default;
const dockerCompose = require('docker-compose');
const dockerode = require('dockerode');
const DataService = require('../../database/data_service');

const docker = new dockerode();

const checkForUpdates = async (plugin) => {
	let updates = [];
	plugin.setState('updates', updates);
	let images = await docker.listImages({ all: true, digests: true });
	images = camelcaseKeys(images, { deep: true });
	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });
	for (const { id, imageId } of containers) {
		const image = images.find((image) => { return image.id === imageId });
		if (image.repoDigests.length === 0) {
			// console.log(`${imageName} has no local digest (likely built locally).`);
			continue;
		}

		const [, localDigest] = image.repoDigests[(image.repoDigests.length === 1 ? 0 : 1)].split('@');
		const container = docker.getContainer(id);
		let inspect = await container.inspect();
		inspect = camelcaseKeys(inspect, { deep: true });
		const imageName = inspect.config.image;
		const registry = getRegistry(imageName);
		let remoteDigest = null;
		switch (registry) {
			case 'dockerhub':
				try {
					remoteDigest = await getDockerHubDigest(imageName);
				} catch (error) {}
				break;
			case 'ghcr':
				try {
					remoteDigest = await getGHCRDigest(imageName);
				} catch (error) {}
				break;
			case 'lscr':
				try {
					remoteDigest = await getLSCRDigest(imageName);
				} catch (error) {}
				break;
			default:
				// console.log(`Unknown registry for image ${imageName}`);
				continue;
		}

		if (!remoteDigest) {
			// console.log(`Could not fetch remote digest for ${imageName}`);
			continue;
		}
		
		if (localDigest !== remoteDigest) {
			updates.push({ imageName: imageName, containerId: id });
			plugin.setState('updates', updates);
		}
	}
	plugin.getNsp().emit('app:updates', plugin.getState('updates'));
	return ``;

	function getRegistry(imageName) {
		if (imageName.startsWith('ghcr.io/')) return 'ghcr';
		if (imageName.startsWith('lscr.io/')) return 'lscr';
		return 'dockerhub';
	}

	function parseDockerHubRepo(image) {
		let [repoPath, tag = 'latest'] = image.split(':');
		if (repoPath.startsWith('docker.io/')) {
			repoPath = repoPath.replace('docker.io/', '');
		}
		if (!repoPath.includes('/')) {
			return { repoPath: `library/${repoPath}`, tag };
		}
		return { repoPath, tag };
	}

	async function getDockerHubDigest(image) {
		const { repoPath, tag } = parseDockerHubRepo(image);
		const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		try {
			const response = await fetch(`https://registry-1.docker.io/v2/${repoPath}/manifests/${tag}`, {
				headers: {
					method: 'HEAD',
					Authorization: `Bearer ${tokenData.token}`,
					Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v1+json,application/vnd.oci.image.index.v1+json'
				}
			});
			return response.headers.get('docker-content-digest');
		} catch (err) {
			return null;
		}
	}

	async function getGHCRDigest(image) {
		const [imageName, tag = 'latest'] = image.split(':');
		const repoPath = imageName.replace('ghcr.io/', '');
		const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		try {
			const response = await fetch(`https://ghcr.io/v2/${repoPath}/manifests/${tag}`, {
				headers: {
					method: 'HEAD',
					Authorization: `Bearer ${tokenData.token}`,
					Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v1+json,application/vnd.oci.image.index.v1+json'
				}
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return response.headers.get('docker-content-digest');
		} catch (err) {
			return null;
		}
	}

	async function getLSCRDigest(image) {
		const [imageName, tag = 'latest'] = image.split(':');
		const repoPath = imageName.replace('lscr.io/', '');
		const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		try {
			const response = await fetch(`https://lscr.io/v2/${repoPath}/manifests/${tag}`, {
				headers: {
					method: 'HEAD',
					Authorization: `Bearer ${tokenData.token}`,
					Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v1+json,application/vnd.oci.image.index.v1+json'
				}
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return response.headers.get('docker-content-digest');
		} catch (err) {
			return null;
		}
	}
};

const updateApp = async (job, plugin) => {
	const config = job.data.config;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const container = plugin.getState('containers')?.find((container) => { return container.name === config.name });
	if (!container) {
		throw new Error(`Container for app '${config.name}' not found.`);
	}
	
	const composeProject = container.labels.comDockerComposeProject;
	const composeProjectDir = container.labels.comDockerComposeProjectWorkingDir;
	const composeProjectContainers = plugin.getState('containers')?.filter((container) => {
		return container.labels && container.labels['comDockerComposeProject'] === composeProject;
	});
	await plugin.updateJobProgress(job, `${existingApp.title} update starting...`);
	const template = plugin.getState('templates')?.find((template) => { return template.name === config.name; });
	if (template) {
		try {
			const response = await fetch(plugin.getRawGitHubUrl(template.repository.url, template.repository.stackfile));
			if (response.ok) {
				const stack = await response.text();
				await plugin.updateJobProgress(job, `Writing ${template.title} project template...`);
				await fs.promises.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
				const icon = template.logo.split('/').pop();
				const responseIcon = await fetch(template.logo);
				if (responseIcon.ok) {
					await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
					const updatedApp = { ...existingApp, icon: icon };
					await DataService.setApplication(updatedApp);
					plugin.getInternalEmitter().emit('configured:updated');
				}
			}
		} catch (error) {}
	}

	await plugin.updateJobProgress(job, `Downloading ${existingApp.title} updates...`);
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await plugin.updateJobProgress(job, chunk.toString());
		}
	});
	await plugin.updateJobProgress(job, `Installing ${existingApp.title} updates...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await plugin.updateJobProgress(job, chunk.toString());
		}
	});
	await plugin.updateJobProgress(job, `Cleaning up...`);
	await docker.pruneImages();
	let updates = plugin.getState('updates')?.filter((update) => {
		return !composeProjectContainers.some((container) => { return container.id === update.containerId; });
	});
	plugin.setState('updates', updates);
	plugin.getNsp().emit('app:updates', plugin.getState('updates'));
	return `${existingApp.title} updated.`;
};

module.exports = {
	name: 'update',
	register(plugin) {
		checkForUpdates(plugin);

		// Schedule updates checker to run daily at midnight
		plugin.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
	},
	onConnection(socket, plugin) {
		if (this.getState('updates')) {
			this.getNsp().emit('app:updates', this.getState('updates'));
		}
		
		socket.on('app:update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('app:update', { config, username: socket.username });
		});
	},
	jobs: {
		'updates:check': async (job, plugin) => {
			checkForUpdates(plugin);
			return '';
		},
		'app:update': updateApp
	}
};
