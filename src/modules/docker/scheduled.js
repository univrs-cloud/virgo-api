const fs = require('fs');
const path = require('path');
const camelcaseKeys = require('camelcase-keys').default;
const docker = require('../../utils/docker_client');

const getRegistry = (imageName) => {
	if (imageName.startsWith('ghcr.io/')) return 'ghcr';
	if (imageName.startsWith('lscr.io/')) return 'lscr';
	return 'dockerhub';
};

const parseDockerHubRepo = (image) => {
	let [repoPath, tag = 'latest'] = image.split(':');
	if (repoPath.startsWith('docker.io/')) {
		repoPath = repoPath.replace('docker.io/', '');
	}
	if (!repoPath.includes('/')) {
		return { repoPath: `library/${repoPath}`, tag };
	}
	return { repoPath, tag };
};

const getDockerHubDigest = async (image, platform = { os: 'linux', architecture: 'arm64' }) => {
	try {
		const { repoPath, tag } = parseDockerHubRepo(image);
		const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		const headers = {
			Method: 'HEAD',
			Authorization: `Bearer ${tokenData.token}`,
			Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json'
		};
		const manifestResponse = await fetch(`https://registry-1.docker.io/v2/${repoPath}/manifests/${tag}`, { headers });
		if (!manifestResponse.ok) {
			throw new Error(`HTTP ${manifestResponse.status} manifest ${repoPath}`);
		}

		return manifestResponse.headers.get('docker-content-digest');
	} catch (error) {
		console.warn(error.message);
		return null;
	}
};

const getGHCRDigest = async (image, platform = { os: 'linux', architecture: 'arm64' }) => {
	try {
		const [imageName, tag = 'latest'] = image.split(':');
		const repoPath = imageName.replace('ghcr.io/', '');
		const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		const headers = {
			Method: 'HEAD',
			Authorization: `Bearer ${tokenData.token}`,
			Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json'
		};
		const manifestResponse = await fetch(`https://ghcr.io/v2/${repoPath}/manifests/${tag}`, { headers });
		if (!manifestResponse.ok) {
			throw new Error(`HTTP ${manifestResponse.status} manifest ${imageName}`);
		}

		return manifestResponse.headers.get('docker-content-digest');
	} catch (error) {
		console.warn(error.message);
		return null;
	}
};

const getLSCRDigest = async (image, platform = { os: 'linux', architecture: 'arm64' }) => {
	try {
		const [imageName, tag = 'latest'] = image.split(':');
		const repoPath = imageName.replace('lscr.io/', '');
		const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${repoPath}:pull`);
		const tokenData = await tokenResponse.json();
		const headers = {
			Method: 'HEAD',
			Authorization: `Bearer ${tokenData.token}`,
			Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json'
		};
		const manifestResponse = await fetch(`https://lscr.io/v2/${repoPath}/manifests/${tag}`, { headers });
		if (!manifestResponse.ok) {
			throw new Error(`HTTP ${manifestResponse.status} manifest ${imageName}`);
		}

		return manifestResponse.headers.get('docker-content-digest');
	} catch (error) {
		console.warn(error.message);
		return null;
	}
};

const checkForUpdates = async (module) => {
	let updates = [];
	module.setState('updates', updates);
	let images = await docker.listImages({ all: true, digests: true });
	images = camelcaseKeys(images, { deep: true });
	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });
	for (const { id, imageId } of containers) {
		const image = images.find((image) => { return image.id === imageId });
		if (!Array.isArray(image?.repoDigests) || image.repoDigests.length === 0) {
			continue;
		}

		const localDigests = image.repoDigests.map((repoDigest) => { return repoDigest.split('@')[1] || null; });
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
		
		if (!localDigests.includes(remoteDigest)) {
			updates.push({ imageName: imageName, containerId: id });
			module.setState('updates', updates);
		}
	}
	for (const socket of module.nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('app:updates', module.getState('updates'));
		}
	}
};

const fetchStackFiles = async (module) => {
	try {
		const composeDir = module.composeDir;
		
		// Check if compose directory exists
		try {
			await fs.promises.access(composeDir);
		} catch (error) {
			console.warn(`Compose directory ${composeDir} does not exist. Skipping compose files update.`);
			return;
		}

		// Get all directories in the compose directory
		const entries = await fs.promises.readdir(composeDir, { withFileTypes: true });
		const appDirs = entries
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name);

		// Get templates from module state
		const templates = module.getState('templates') || [];
		
		// Update compose files for each app that has a template
		for (const appName of appDirs) {
			const template = templates.find((template) => { return template.name === appName; });
			
			if (!template) {
				continue; // Skip if no template exists for this app
			}

			// Only update if template has repository information
			if (!template.repository?.url || !template.repository?.stackfile) {
				continue;
			}

			try {
				const composeFilePath = path.join(composeDir, appName, 'docker-compose.yml');
				
				// Check if docker-compose.yml file exists
				try {
					await fs.promises.access(composeFilePath);
				} catch (error) {
					// File doesn't exist, skip
					continue;
				}

				// Download the template
				const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
				if (!response.ok) {
					console.warn(`Failed to download template for ${appName}: HTTP ${response.status}`);
					continue;
				}

				const stack = await response.text();
				
				// Replace the docker-compose.yml file
				await fs.promises.writeFile(composeFilePath, stack, 'utf-8');
				console.log(`Updated docker-compose.yml for ${appName}`);
			} catch (error) {
				console.warn(`Error updating compose file for ${appName}:`, error.message);
			}
		}
	} catch (error) {
		console.error(`Error updating compose files:`, error);
	}
};

const register = (module) => {
	checkForUpdates(module);

	// Schedule updates checker to run daily at midnight
	module.addJobSchedule(
		'app:updates:check',
		{ pattern: '0 0 0 * * *' }
	);

	// Schedule templates fetcher to run every hour at minute 1
	module.addJobSchedule(
		'app:templates:fetch',
		{ pattern: '0 1 * * * *' }
	);

	// Schedule compose files updater to run daily at midnight
	module.addJobSchedule(
		'app:stackfiles:fetch',
		{ pattern: '0 0 0 * * *' }
	);
};

const onConnection = (socket, module) => {
	if (socket.isAuthenticated && socket.isAdmin) {
		if (module.getState('updates')) {
			socket.emit('app:updates', module.getState('updates'));
		}
	}
};

module.exports = {
	name: 'scheduled',
	register,
	onConnection,
	jobs: {
		'app:updates:check': async (job, module) => {
			await checkForUpdates(module);
			return ``;
		},
		'app:templates:fetch': async (job, module) => {
			module.eventEmitter.emit('app:templates:fetch');
			return ``;
		},
		'app:stackfiles:fetch': async (job, module) => {
			await fetchStackFiles(module);
			return ``;
		}
	}
};
