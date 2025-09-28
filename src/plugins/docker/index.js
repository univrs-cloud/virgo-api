const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');
const BasePlugin = require('../base');
const DataService = require('../../database/data_service');

const docker = new dockerode();

class DockerPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'docker');
	}

	init() {
		this.composeDir = '/opt/docker';
		this.loadConfigured();
		
		this.getInternalEmitter().on('configured:updated', () => {
			this.loadConfigured();
		});
	}

	onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		
		if (this.getState('configured')) {
			this.getNsp().emit('app:configured', this.getState('configured'));
		}
		if (this.getState('containers')) {
			this.getNsp().emit('app:containers', this.getState('containers'));
		} else {
			pollingPlugin.pollContainers(socket, this);
		}
		if (this.getState('templates')) {
			if (socket.isAuthenticated) {
				this.getNsp().to(`user:${socket.username}`).emit('app:templates', this.getState('templates'));
			}
		} else {
			this.fetchTemplates();
		}
		if (this.getState('updates')) {
			this.getNsp().emit('app:updates', this.getState('updates'));
		} else {
			this.checkForUpdates();
		}
	}
	
	async checkForUpdates() {
		let updates = [];
		this.setState('updates', updates);
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
					remoteDigest = await getDockerHubDigest(imageName);
					break;
				case 'ghcr':
					remoteDigest = await getGHCRDigest(imageName);
					break;
				case 'lscr':
					remoteDigest = await getLSCRDigest(imageName);
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
				this.setState('updates', updates);
			}
		}
		this.getNsp().emit('app:updates', this.getState('updates'));
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
	}

	async fetchTemplates() {
		try {
			const response = await fetch(`https://apps.univrs.cloud/template.json`);
			const data = await response.json();
			this.setState('templates', data.templates);
		} catch (error) {
			this.setState('templates', false);
		}
	
		for (const socket of this.getNsp().sockets.values()) {
			if (socket.isAuthenticated) {
				this.getNsp().to(`user:${socket.username}`).emit('app:templates', this.getState('templates'));
			}
		}
	}
	
	getRawGitHubUrl(repositoryUrl, filePath, branch = 'main') {
		const { hostname, pathname } = new URL(repositoryUrl);
		const [owner, repository] = pathname.split('/').filter(Boolean);
		if (hostname.includes('github.com')) {
			const rawHostname = hostname.replace('github.com', 'raw.githubusercontent.com');
			return `https://${rawHostname}/${owner}/${repository}/${branch}/${filePath}`;
		}
	
		throw new Error(`Unsupported apps repository.`);
	}

	async loadConfigured() {
		try {
			const configuration = await DataService.getConfigured();
			this.setState('configured', { configuration });
			this.getNsp().emit('app:configured', this.getState('configured'));
		} catch (error) {
			console.error('Error loading configuration:', error);
		}
	}
}

module.exports = (io) => {
	return new DockerPlugin(io);
};
