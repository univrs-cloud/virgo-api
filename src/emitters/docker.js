const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const stream = require('stream');
const streamPipeline = util.promisify(stream.pipeline);
const path = require('path');
const touch = require('touch');
const changeCase = require('change-case');
const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');
const dockerCompose = require('docker-compose');
const BaseEmitter = require('./base');
const FileWatcher = require('../utils/file_watcher');

const docker = new dockerode();

class DockerEmitter extends BaseEmitter {
	#dataFileWatcher;
	#dataFile = '/var/www/virgo-api/data.json';
	#composeDir = '/opt/docker';
	#allowedActions = ['start', 'stop', 'kill', 'restart', 'down'];

	constructor(io) {
		super(io, 'docker');
		this.#watchData();
		this.#scheduleUpdatesChecker();
		this.#scheduleTemplatesFetcher();
	}

	onConnection(socket) {
		if (this.getState('configured')) {
			this.getNsp().emit('configured', this.getState('configured'));
		}
		if (this.getState('containers')) {
			this.getNsp().emit('containers', this.getState('containers'));
		} else {
			this.#pollContainers(socket);
		}
		if (this.getState('templates')) {
			if (socket.isAuthenticated) {
				this.getNsp().to(`user:${socket.username}`).emit('templates', this.getState('templates'));
			}
		} else {
			this.#fetchTemplates();
		}
		if (this.getState('updates')) {
			this.getNsp().emit('updates', this.getState('updates'));
		} else {
			this.#checkForUpdates();
		}

		socket.on('install', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('appInstall', { config, username: socket.username });
		});

		socket.on('update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('appUpdate', { config, username: socket.username });
		});

		socket.on('performAppAction', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('appPerformAction', { config, username: socket.username });
		});

		socket.on('performServiceAction', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('servicePerformAction', { config, username: socket.username });
		});

		socket.on('createBookmark', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('bookmarkCreate', { config, username: socket.username });
		});

		socket.on('updateBookmark', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('bookmarkUpdate', { config, username: socket.username });
		});

		socket.on('deleteBookmark', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('bookmarkDelete', { config, username: socket.username });
		});

		socket.on('terminalConnect', (id) => { this.#terminalConnect(socket, id); });
		socket.on('logsConnect', (id) => { this.#logsConnect(socket, id); });
	}

	async processJob(job) {
		if (job.name === 'checkForUpdates') {
			return await this.#checkForUpdates();
		}
		if (job.name === 'fetchTemplates') {
			return await this.#fetchTemplates();
		}
		if (job.name === 'appInstall') {
			return await this.#install(job);
		}
		if (job.name === 'appUpdate') {
			return await this.#update(job);
		}
		if (job.name === 'appPerformAction') {
			return await this.#performAppAction(job);
		}
		if (job.name === 'servicePerformAction') {
			return await this.#performServiceAction(job);
		}
		if (job.name === 'bookmarkCreate') {
			return await this.#createBookmark(job);
		}
		if (job.name === 'bookmarkUpdate') {
			return await this.#updateBookmark(job);
		}
		if (job.name === 'bookmarkDelete') {
			return await this.#deleteBookmark(job);
		}
	}

	#watchData() {
		const readFile = () => {
			let data = fs.readFileSync(this.#dataFile, { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data !== '') {
				this.setState('configured', JSON.parse(data));
				this.getNsp().emit('configured', this.getState('configured'));
			}
		};

		if (this.#dataFileWatcher) {
			return;
		}
	
		if (!fs.existsSync(this.#dataFile)) {
			touch.sync(this.#dataFile);
		}
	
		if (this.getState('configured') === undefined) {
			this.setState('configured', {});
			readFile();
		}
	
		this.#dataFileWatcher = new FileWatcher(this.#dataFile);
		this.#dataFileWatcher
			.onChange((event, path) => {
				readFile();
			});
	}

	async #scheduleUpdatesChecker() {
		this.addJobSchedule(
			'checkForUpdates',
			{ pattern: '0 0 0 * * *' }
		);
	}
	
	async #scheduleTemplatesFetcher() {
		this.addJobSchedule(
			'fetchTemplates',
			{ pattern: '0 1 * * * *' }
		);
	}

	async #checkForUpdates() {
		let updates = [];
		this.setState('updates', updates);
		let images = await docker.listImages({ all: true, digests: true });
		images = camelcaseKeys(images, { deep: true });
		let containers = await docker.listContainers({ all: true });
		containers = camelcaseKeys(containers, { deep: true });
		containers.forEach(async ({ id, imageId }) => {
			const image = images.find((image) => { return image.id === imageId });
			if (image.repoDigests.length === 0) {
				// console.log(`${imageName} has no local digest (likely built locally).`);
				return;
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
					return;
			}
	
			if (!remoteDigest) {
				// console.log(`Could not fetch remote digest for ${imageName}`);
				return;
			}
			
			if (localDigest !== remoteDigest) {
				updates.push({ imageName: imageName, containerId: id });
				this.setState('updates', updates);
			}
		});
		this.getNsp().emit('updates', this.getState('updates'));
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

	async #fetchTemplates() {
		try {
			const response = await fetch(`https://apps.univrs.cloud/template.json`);
			const data = await response.json();
			this.setState('templates', data.templates);
		} catch (error) {
			this.setState('templates', false);
		}
	
		for (const socket of this.getNsp().sockets.values()) {
			if (socket.isAuthenticated) {
				this.getNsp().to(`user:${socket.username}`).emit('templates', this.getState('templates'));
			}
		}
	}

	async #pollContainers(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('containers', []);
			return;
		}
	
		try {
			let containers = await docker.listContainers({ all: true });
			containers = camelcaseKeys(containers, { deep: true });
			containers = containers.map((container) => {
				container.name = container.names[0].replace('/', '');
				return container;
			});
			this.setState('containers', containers);
		} catch (error) {
			this.setState('containers', false);
		}
	
		this.getNsp().emit('containers', this.getState('containers'));
		setTimeout(() => { this.#pollContainers(socket); }, 2000);
	}

	async #install(job) {
		let config = job.data.config;
		let template = this.getState('templates')?.find((template) => { return template.id === config.id; });
		if (!template) {
			throw new Error(`App template not found.`);
		}
	
		if (template.type !== 3) { // only docker compose is supported
			throw new Error(`Installing this app type is not supported.`);
		}
	
		const existingApp = this.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === template?.name; });
		if (existingApp) {
			throw new Error(`App already installed.`);
		}
	
		await this.updateJobProgress(job, `${template.title} installation starting...`);
		await this.updateJobProgress(job, `Downloading ${template.title} project template...`);
		const response = await fetch(this.#getRawGitHubUrl(template.repository.url, template.repository.stackfile));
		const stack = await response.text();
		let env = Object.entries(config.env).map(([key, value]) => `${key}='${value}'`).join('\n');
		const composeProjectDir = path.join(this.#composeDir, template.name);
		await this.updateJobProgress(job, `Making ${template.title} project directory...`);
		fs.mkdirSync(composeProjectDir, { recursive: true });
		await this.updateJobProgress(job, `Writing ${template.title} project template...`);
		fs.writeFileSync(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8', { flag: 'w' });
		await this.updateJobProgress(job, `Writing ${template.title} project configuration...`);
		fs.writeFileSync(path.join(composeProjectDir, '.env'), env, 'utf-8', { flag: 'w' });
		await this.updateJobProgress(job, `Installing ${template.title}...`);
		await dockerCompose.upAll({
			cwd: composeProjectDir,
			callback: async (chunk) => {
				await this.updateJobProgress(job, chunk.toString());
			}
		});
	
		const icon = template.logo.split('/').pop();
		const responseIcon = await fetch(template.logo);
		await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
		let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
		// configuration = configuration.filter((entity) => { return entity.name !== template?.name });
		const app = {
			name: template.name,
			type: 'app',
			canBeRemoved: true,
			category: template.categories.find((_, index) => { return index === 0; }),
			icon: icon,
			title: template.title
		};
		configuration.push(app);
		await this.updateJobProgress(job, `Updating apps configuration...`);
		fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
		return `${template.title} installed.`;
	}

	async #update(job) {
		let config = job.data.config;
		const existingApp = this.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === config?.name; });
		if (!existingApp) {
			throw new Error(`App not found.`);
		}
	
		let template = this.getState('templates')?.find((template) => { return template.name === config.name; });
		const container = this.getState('containers')?.find((container) => { return container.name === config.name });
		const composeProject = container.labels.comDockerComposeProject;
		const composeProjectDir = container.labels.comDockerComposeProjectWorkingDir;
		const composeProjectContainers = this.getState('containers')?.filter((container) => {
			return container.labels && container.labels['comDockerComposeProject'] === composeProject;
		});
		await this.updateJobProgress(job, `${existingApp.title} update starting...`);
		if (template) {
			try {
				const response = await fetch(this.#getRawGitHubUrl(template.repository.url, template.repository.stackfile));
				const stack = await response.text();
				await this.updateJobProgress(job, `Writing ${template.title} project template...`);
				fs.writeFileSync(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8', { flag: 'w' });
				const icon = template.logo.split('/').pop();
				const responseIcon = await fetch(template.logo);
				await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
				let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
				configuration = configuration.map((entity) => {
					if (entity.type === 'app' && entity.name === config.name) {
						entity.icon = icon;
					}
					return entity;
				});
				fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
			} catch (error) {}
		}
	
		await this.updateJobProgress(job, `Downloading ${existingApp.title} updates...`);
		await dockerCompose.pullAll({
			cwd: composeProjectDir,
			callback: async (chunk) => {
				await this.updateJobProgress(job, chunk.toString());
			}
		});
		await this.updateJobProgress(job, `Installing ${existingApp.title} updates...`);
		await dockerCompose.upAll({
			cwd: composeProjectDir,
			callback: async (chunk) => {
				await this.updateJobProgress(job, chunk.toString());
			}
		});
		await this.updateJobProgress(job, `Cleaning up...`);
		await docker.pruneImages();
		let updates = this.getState('updates')?.filter((update) => {
			return !composeProjectContainers.some((container) => { return container.id === update.containerId; });
		});
		this.setState('updates', updates);
		this.getNsp().emit('updates', this.getState('updates'));
		return `${existingApp.title} updated.`;
	}

	async #performAppAction(job) {
		let config = job.data.config;
		if (!this.#allowedActions.includes(config?.action)) {
			throw new Error(`Not allowed to perform ${config?.action} on apps.`);
		}
	
		const existingApp = this.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === config?.name; });
		if (!existingApp) {
			throw new Error(`App not found.`);
		}
	
		await this.updateJobProgress(job, `${existingApp.title} app is ${config.action}ing...`);
	
		const container = this.getState('containers')?.find((container) => {
			return container.names.includes(`/${config.name}`);
		});
		const composeProject = container.labels.comDockerComposeProject ?? false;
		if (composeProject === false) {
			throw new Error(`${existingApp.title} app is not set up to perform ${config.action}.`);
		}
	
		await exec(`docker compose -p ${composeProject} ${config.action}`);
		if (config.action === 'down') {
			let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
			configuration = configuration.filter((entity) => { return entity.name !== config.name });
			fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
		}
		// } else {
		// 	await docker.getContainer(container.id)[config.action]();
		// }
	
		return `${existingApp.title} app ${config.action}ed.`;
	}
	
	async #performServiceAction(job) {
		let config = job.data.config;
		if (!this.#allowedActions.includes(config?.action)) {
			throw new Error(`Not allowed to perform ${config?.action} on services.`);
		}
	
		const container = this.getState('containers')?.find((container) => {
			return container.id === config?.id;
		});
		if (!container) {
			throw new Error(`Service not found.`);
		}
	
		await this.updateJobProgress(job, `${container.name} service is ${config.action}ing...`);
		await docker.getContainer(container.id)[config.action]();
		return `${container.name} service ${config.action}ed.`;
	}

	async #createBookmark(job) {
		let config = job.data.config;
		await this.updateJobProgress(job, `${config?.title} bookmark is creating...`);
		let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
		configuration = configuration.filter((entity) => { return entity.url !== config?.url });
		configuration.push({
			name: changeCase.kebabCase(config.title),
			type: 'bookmark',
			canBeRemoved: true,
			category: config.category,
			icon: '',
			title: config.title,
			url: config.url
		});
		fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
		return `${config.title} bookmark created.`;
	}
	
	async #updateBookmark(job) {
		let config = job.data.config;
		const existingBookmark = this.getState('configured')?.configuration.find((entity) => { return entity.type === 'bookmark' && entity.name === config?.name; });
		if (!existingBookmark) {
			throw new Error(`Bookmark not found.`);
		}
	
		await this.updateJobProgress(job, `${existingBookmark.title} bookmark is updating...`);
		let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
		configuration = configuration.filter((entity) => { return entity.name !== config.name; });
		configuration.push({
			name: changeCase.kebabCase(config.title),
			type: 'bookmark',
			canBeRemoved: true,
			category: config.category,
			icon: '',
			title: config.title,
			url: config.url
		});
		fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
		return `${existingBookmark.title} bookmark updated.`;
	}
	
	async #deleteBookmark(job) {
		let config = job.data.config;
		const existingBookmark = this.getState('configured')?.configuration.find((entity) => { return entity.type === 'bookmark' && entity.name === config?.name; });
		if (!existingBookmark) {
			throw new Error(`Bookmark not found.`);
		}
	
		await this.updateJobProgress(job, `${existingBookmark.title} bookmark is deleting...`);
		let configuration = [...this.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
		configuration = configuration.filter((entity) => { return entity.name !== config.name });
		fs.writeFileSync(this.#dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
		return `${existingBookmark.title} bookmark deleted.`;
	}

	async #terminalConnect(socket, id) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		const container = docker.getContainer(id);
		if (!container) {
			return;
		}
	
		let shell = findContainerShell(id);
		if (!shell) {
			this.getNsp().to(`user:${socket.username}`).emit('terminalError', 'No compatible shell found in container.');
			return;
		}
	
		try {
			const exec = await container.exec(
				{
					Cmd: [`/bin/${shell}`],
					AttachStdin: true,
					AttachStdout: true,
					AttachStderr: true,
					Tty: true
				}
			);
			const stream = await exec.start(
				{
					stream: true,
					stdin: true,
					stdout: true,
					stderr: true,
					hijack: true
				}
			);
			// Pipe container output to the client
			// Create readable streams for stdout and stderr
			const stdout = new require('stream').PassThrough();
			const stderr = new require('stream').PassThrough();
			docker.modem.demuxStream(stream, stdout, stderr);
			stdout.on('data', (data) => { this.getNsp().to(`user:${socket.username}`).emit('terminalOutput', data.toString('utf8')) });
			stderr.on('data', (data) => { this.getNsp().to(`user:${socket.username}`).emit('terminalOutput', data.toString('utf8')) });
			// Pipe client input to the container
			socket.on('terminalInput', (data) => {
				stream.write(data);
			});
			socket.on('terminalResize', (size) => {
				exec.resize({
					h: size.rows,
					w: size.cols
				});
			});
			// Client terminated the connection
			socket.on('terminalDisconnect', () => {
				stream.destroy();
			});
			socket.on('disconnect', () => {
				stream.destroy();
			});
			this.getNsp().to(`user:${socket.username}`).emit('terminalConnected');
		} catch (error) {
			console.error(error);
			this.getNsp().to(`user:${socket.username}`).emit('terminalError', 'Failed to start container terminal stream.');
		}
	
		function findContainerShell(id) {
			const commonShells = ['bash', 'sh', 'zsh', 'ash', 'dash'];
			for (const shell of commonShells) {
				try {
					childProcess.execSync(`docker exec ${id} ${shell} -c 'exit 0'`, { stdio: 'ignore' });
					return shell;
				} catch (error) {
					continue;
				}
			}
			return null;
		}
	}
	
	async #logsConnect(socket, id) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		const container = docker.getContainer(id);
		if (!container) {
			return;
		}
	
		try {
			const stream = await container.logs(
				{
					follow: true,
					stdout: true,
					stderr: true,
					tail: 100
				}
			);
			// Pipe container output to the client
			// Create readable streams for stdout and stderr
			const stdout = new require('stream').PassThrough();
			const stderr = new require('stream').PassThrough();
			docker.modem.demuxStream(stream, stdout, stderr);
			stdout.on('data', (data) => { this.getNsp().to(`user:${socket.username}`).emit('logsOutput', data.toString('utf8')) });
			stderr.on('data', (data) => { this.getNsp().to(`user:${socket.username}`).emit('logsOutput', data.toString('utf8')) });
			// Client terminated the connection
			socket.on('logsDisconnect', () => {
				stream.destroy();
			});
			socket.on('disconnect', () => {
				stream.destroy();
			});
			this.getNsp().to(`user:${socket.username}`).emit('logsConnected');
		} catch (error) {
			this.getNsp().to(`user:${socket.username}`).emit('logsError', 'Failed to start container logs stream.');
		}
	}

	#getRawGitHubUrl(repositoryUrl, filePath, branch = 'main') {
		const { hostname, pathname } = new URL(repositoryUrl);
		const [owner, repository] = pathname.split('/').filter(Boolean);
		if (hostname.includes('github.com')) {
			const rawHostname = hostname.replace('github.com', 'raw.githubusercontent.com');
			return `https://${rawHostname}/${owner}/${repository}/${branch}/${filePath}`;
		}
	
		throw new Error(`Unsupported apps repository.`);
	}
}

module.exports = (io) => {
	return new DockerEmitter(io);
};
