const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');

const docker = new dockerode();

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
		}
	}
};
