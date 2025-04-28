const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const path = require('path');
const touch = require('touch');
const axios = require('axios');
const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');
const dockerCompose = require('docker-compose');
const { Queue, Worker } = require('bullmq');

let nsp;
let state = {};
let dataFileWatcher = null;
const docker = new dockerode();
const composeDir = '/opt/docker';
const allowedActions = ['start', 'stop', 'kill', 'restart', 'remove'];
const dataFile = '/var/www/virgo-api/data.json';
const queue = new Queue('docker-jobs');
const worker = new Worker(
	'docker-jobs',
	async (job) => {
		if (job.name === 'appInstall') {
			return await install(job);
		}
		if (job.name === 'appUpdate') {
			return await update(job);
		}
		if (job.name === 'performAppAction') {
			return await performAppAction(job);
		}
		if (job.name === 'performServiceAction') {
			return await performServiceAction(job);
		}
		if (job.name === 'checkForUpdates') {
			return await checkForUpdates(job);
		}
	},
	{
		connection: {
			host: 'localhost',
			port: 6379,
		}
	}
);
worker.on('completed', async (job, result) => {
	if (job) {
		await job.updateProgress({ state: await job.getState(), message: result });
	}
});
worker.on('failed', async (job, error) => {
	if (job) {
		await job.updateProgress({ state: await job.getState(), message: `` });
	}
});
worker.on('error', (error) => {
	console.error(error);
});

const scheduleUpdatesChecker = async () => {
	const updatesChecker = await queue.getJobScheduler('updatesChecker');
	if (updatesChecker) {
		return;
	}

	queue.upsertJobScheduler(
		'updatesChecker',
		{ pattern: '0 0 0 * * *' },
		{ name: 'checkForUpdates' }
	)
		.catch((error) => {
			console.error('Error starting job:', error);
		});
};

const watchData = (socket) => {
	if (dataFileWatcher !== null) {
		return;
	}

	touch.sync(dataFile);

	if (state.configured === undefined) {
		state.configured = {};
		readFile();
	}

	dataFileWatcher = fs.watch(dataFile, (eventType) => {
		if (eventType === 'change') {
			readFile();
		}
	});

	function readFile() {
		let data = fs.readFileSync(dataFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			state.configured = JSON.parse(data);
			nsp.emit('configured', state.configured);
		}
	};
}

const pollContainers = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.containers;
		return;
	}

	docker.listContainers({ all: true })
		.then((containers) => {
			containers = camelcaseKeys(containers, { deep: true });
			containers = containers.map((container) => {
				container.name = container.names[0].replace('/', '');
				return container;
			});
			state.containers = containers;
		})
		.catch((error) => {
			state.containers = false;
		})
		.then(() => {
			nsp.emit('containers', state.containers);
			setTimeout(pollContainers.bind(null, socket), 2000);
		});
};

const pollTemplates = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.templates;
		return;
	}

	if (!socket.isAuthenticated) {
		return;
	}

	state.templates = [];

	axios.get('https://apps.univrs.cloud/template.json')
		.then((response) => {
			state.templates = response.data.templates;
		})
		.catch((error) => {
			state.templates = false;
		})
		.then(() => {
			nsp.to(`user:${socket.user}`).emit('templates', state.templates);
			setTimeout(pollTemplates.bind(null, socket), 3600000);
		});
};

const install = async (job) => {
	let config = job.data.config;
	let template = state.templates.find((template) => {
		return template.id === config.id;
	});
	if (!template) {
		throw new Error('App template not found.');
	}

	await job.updateProgress({ state: await job.getState(), message: `${template.title} installation starting...` });

	if (template.type === 1) {
		// install using docker run
		throw new Error('Installing this app type not yet supported.');
	}

	if (template.type === 3) {
		await job.updateProgress({ state: await job.getState(), message: `Downloading ${template.title} project template...` });
		const response = await axios.get(getRawGitHubUrl(template.repository.url, template.repository.stackfile));
		let stack = response.data;
		let env = Object.entries(config.env).map(([key, value]) => `${key}='${value}'`).join('\n');
		const composeProjectDir = path.join(composeDir, template.name);
		await job.updateProgress({ state: await job.getState(), message: `Making ${template.title} project directory...` });
		fs.mkdirSync(composeProjectDir, { recursive: true });
		await job.updateProgress({ state: await job.getState(), message: `Writing ${template.title} project template...` });
		fs.writeFileSync(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8', { flag: 'w' });
		await job.updateProgress({ state: await job.getState(), message: `Writing ${template.title} project configuration...` });
		fs.writeFileSync(path.join(composeProjectDir, '.env'), env, 'utf-8', { flag: 'w' });
		await job.updateProgress({ state: await job.getState(), message: `Installing ${template.title}...` });
		await dockerCompose.upAll({
			cwd: composeProjectDir,
			callback: async (chunk) => {
				await job.updateProgress({ state: await job.getState(), message: chunk.toString() });
			}
		});
	}

	let configuration = [...state.configured.configuration];
	configuration = configuration.filter((configuration) => { return configuration.name !== template.name });
	configuration.push({
		name: template.name,
		type: 'app',
		canBeRemoved: true,
		category: template.categories.find((_, index) => { return index === 0; }),
		title: template.title,
		icon: template.logo.split('/').pop()
	});
	await job.updateProgress({ state: await job.getState(), message: `Updating apps configuration...` });
	fs.writeFileSync(dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
	return `${template.title} installed.`;

	function getRawGitHubUrl(repositoryUrl, filePath, branch = 'main') {
		const { hostname, pathname } = new URL(repositoryUrl);
		const [owner, repository] = pathname.split('/').filter(Boolean);
		if (hostname.includes('github.com')) {
			const rawHostname = hostname.replace('github.com', 'raw.githubusercontent.com');
			return `https://${rawHostname}/${owner}/${repository}/${branch}/${filePath}`;
		}

		throw new Error(`Unsupported apps repository.`);
	}
};

const update = async (job) => {
	let config = job.data.config;
	let app = state.configured.configuration.find((app) => {
		return app.name === config?.name;
	});
	if (!app) {
		throw new Error(`App not found.`);
	}

	await job.updateProgress({ state: await job.getState(), message: `${app.title} update starting...` });
	await job.updateProgress({ state: await job.getState(), message: `Downloading ${app.title} updates...` });
	const composeProjectDir = path.join(composeDir, app.name);
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await job.updateProgress({ state: await job.getState(), message: chunk.toString() });
		}
	});
	await job.updateProgress({ state: await job.getState(), message: `Installing ${app.title} updates...` });
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await job.updateProgress({ state: await job.getState(), message: chunk.toString() });
		}
	});
	await checkForUpdates();
	return `${app.title} updated.`;
};

const performAppAction = async (job) => {
	let config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on apps.`);
	}

	let configuration = [...state.configured.configuration]; // need to clone so we don't modify the reference
	let app = configuration.find((app) => {
		return app.name === config?.name;
	});
	if (!app) {
		throw new Error(`App not found.`);
	}

	await job.updateProgress({ state: await job.getState(), message: `${app.title} app is ${config.action}ing...` });

	const container = state.containers.find((container) => {
		return container.names.includes(`/${app.name}`);
	});
	composeProject = container.labels.comDockerComposeProject ?? false;
	if (composeProject !== false) {
		await exec(`docker compose -p ${composeProject} ${config.action}`)
	} else {
		await docker.getContainer(container.id)[config.action]();
	}

	if (config.action === 'remove') {
		// configuration = configuration.filter((configuration) => { return configuration.name !== app.name });
		// fs.writeFileSync(dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
	}

	return `${app.title} app ${config.action}ed.`;
};

const performServiceAction = async (job) => {
	let config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on services.`);
	}

	const container = state.containers.find((container) => {
		return container.id === config?.id;
	});
	if (!container) {
		throw new Error(`Service not found.`);
	}

	await job.updateProgress({ state: await job.getState(), message: `${container.name} service is ${config.action}ing...` });
	await docker.getContainer(container.id)[config.action]();
	return `${container.name} service ${config.action}ed.`;
};

const checkForUpdates = async (job) => {
	state.updates = [];
	let images = await docker.listImages({ all: true, digests: true });
	images = camelcaseKeys(images, { deep: true });
	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });
	containers.forEach(async ({ id, imageId }) => {
		const image = images.find((image) => { return image.id === imageId });
		const container = docker.getContainer(id);
		let inspect = await container.inspect();
		inspect = camelcaseKeys(inspect, { deep: true });
		const imageName = inspect.config.image;
		const [, localDigest] = image.repoDigests[0].split('@');
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

		if (!localDigest) {
			// console.log(`${imageName} has no local digest (likely built locally).`);
		} else if (localDigest !== remoteDigest) {
			state.updates.push({ imageName: imageName, containerId: id });
		}
	});
	nsp.emit('updates', state.updates);
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
		const url = `https://registry-1.docker.io/v2/${repoPath}/manifests/${tag}`;
		try {
			const response = await fetch(url, {
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
		const url = `https://ghcr.io/v2/${repoPath}/manifests/${tag}`;
		try {
			const response = await fetch(url, {
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
		const url = `https://lscr.io/v2/${repoPath}/manifests/${tag}`;
		try {
			const response = await fetch(url, {
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

const terminalConnect = (socket, id) => {
	if (!socket.isAuthenticated) {
		return;
	}

	const container = docker.getContainer(id);
	if (!container) {
		return;
	}

	let shell = findContainerShell(id);

	container.exec(
		{
			Cmd: [`/bin/${shell}`],
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			Tty: true
		}
	)
		.then((exec) => {
			return exec.start(
				{
					stream: true,
					stdin: true,
					stdout: true,
					stderr: true,
					hijack: true
				}
			);
		})
		.then((stream) => {
			// Pipe container output to the client
			// Create readable streams for stdout and stderr
			const stdout = new require('stream').PassThrough();
			const stderr = new require('stream').PassThrough();
			docker.modem.demuxStream(stream, stdout, stderr);
			stdout.on('data', (data) => { nsp.to(`user:${socket.user}`).emit('terminalOutput', data.toString('utf8')) });
			stderr.on('data', (data) => { nsp.to(`user:${socket.user}`).emit('terminalOutput', data.toString('utf8')) });
			// Pipe client input to the container
			socket.on('terminalInput', (data) => {
				stream.write(data);
			});
			// Client terminated the connection
			socket.on('terminalDisconnect', () => {
				stream.destroy();
			});
			socket.on('disconnect', () => {
				stream.destroy();
			});
			nsp.to(`user:${socket.user}`).emit('terminalConnected');
		})
		.catch((error) => {
			console.error(error);
			nsp.to(`user:${socket.user}`).emit('terminalError', 'Failed to start container terminal stream.');
		});

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
};

const logsConnect = (socket, id) => {
	if (!socket.isAuthenticated) {
		return;
	}

	const container = docker.getContainer(id);
	if (!container) {
		return;
	}

	container.logs({
		follow: true,
		stdout: true,
		stderr: true,
		tail: 100
	})
		.then((stream) => {
			// Pipe container output to the client
			// Create readable streams for stdout and stderr
			const stdout = new require('stream').PassThrough();
			const stderr = new require('stream').PassThrough();
			docker.modem.demuxStream(stream, stdout, stderr);
			stdout.on('data', (data) => { nsp.to(`user:${socket.user}`).emit('logsOutput', data.toString('utf8')) });
			stderr.on('data', (data) => { nsp.to(`user:${socket.user}`).emit('logsOutput', data.toString('utf8')) });
			// Client terminated the connection
			socket.on('logslDisconnect', () => {
				stream.destroy();
			});
			socket.on('disconnect', () => {
				stream.destroy();
			});
			nsp.to(`user:${socket.user}`).emit('logsConnected');
		})
		.catch((error) => {
			nsp.to(`user:${socket.user}`).emit('logsError', 'Failed to start container logs stream.');
		});
};

scheduleUpdatesChecker();

module.exports = (io) => {
	nsp = io.of('/docker');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		watchData(socket);

		if (state.configured) {
			nsp.emit('configured', state.configured);
		}
		if (state.containers) {
			nsp.emit('containers', state.containers);
		} else {
			pollContainers(socket);
		}
		if (state.templates) {
			if (socket.isAuthenticated) {
				nsp.to(`user:${socket.user}`).emit('templates', state.templates);
			}
		} else {
			pollTemplates(socket);
		}
		if (state.updates) {
			nsp.emit('updates', state.updates);
		} else {
			checkForUpdates();
		}

		socket.on('install', (config) => {
			if (socket.isAuthenticated) {
				queue.add('appInstall', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('update', (config) => {
			if (socket.isAuthenticated) {
				queue.add('appUpdate', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('performAppAction', (config) => {
			if (socket.isAuthenticated) {
				queue.add('performAppAction', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('performServiceAction', (config) => {
			if (socket.isAuthenticated) {
				queue.add('performServiceAction', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('terminalConnect', (id) => { terminalConnect(socket, id); });
		socket.on('logsConnect', (id) => { logsConnect(socket, id); });

		socket.on('disconnect', () => {
			//
		});
	});
};
