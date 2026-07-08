import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Queue, Worker } from 'bullmq';
import config from '../../config.js';
import eventEmitter from '../utils/event_emitter.js';
import * as socket from '../socket.js';
import * as trustedProxy from '../utils/trusted_proxy.js';
import * as nlp from '../utils/nlp.js';
import { getQueueName, getScheduledQueueName } from '../queues.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class BaseModule {
	#name;
	#io;
	#nsp;
	#eventEmitter;
	#state = {};
	#queue;
	#worker;
	#scheduledQueue;
	#scheduledWorker;
	#plugins = [];

	constructor(name) {
		this.#name = name;
		this.#io = socket.getIO();
		this.#nsp = this.#io.of(`/${this.#name}`);
		this.#eventEmitter = eventEmitter;

		this.#setupMiddleware();
		this.#setupConnectionHandlers();
		this.#setupQueues();

		setImmediate(() => {
			this.#loadPlugins();
		});
	}

	get nsp() {
		return this.#nsp;
	}

	get eventEmitter() {
		return this.#eventEmitter;
	}

	get nlp() {
		return nlp;
	}

	getState(key) {
		return structuredClone(this.#state[key]);
	}

	setState(key, state) {
		this.#state[key] = state;
	}

	getPlugins() {
		return this.#plugins;
	}

	getPlugin(name) {
		return this.#plugins.find((plugin) => { return plugin.name === name; });
	}

	async addJob(name, data) {
		try {
			await this.#queue.add(name, data);
		} catch (error) {
			console.error(`Error starting job:`, error);
		}
	}

	async addJobSchedule(name, pattern) {
		try {
			await this.#scheduledQueue.upsertJobScheduler(
				name,
				pattern,
				{
					name: name,
					opts: {
						removeOnComplete: 1,
						removeOnFail: 1
					}
				}
			);
		} catch (error) {
			console.error(`Error starting job:`, error);
		}
	}

	async updateJobProgress(job, message, progress = {}) {
		try {
			const state = await job.getState();
			await job.updateProgress({ state, message, progress });
		} catch (error) {
			console.error(`Failed to update job progress:`, error);
		}
	}

	toArray(value) {
		return Array.isArray(value) ? value : [];
	}

	#setupMiddleware() {
		this.#nsp.use((socket, next) => {
			const isTrusted = trustedProxy.isFromTrustedProxy(socket.conn?.remoteAddress);
			const remoteUser = isTrusted ? (socket.handshake.headers['remote-user'] ?? socket.handshake.auth?.['remote-user']) : undefined;
			const remoteGroups = isTrusted ? (socket.handshake.headers['remote-groups'] ?? socket.handshake.auth?.['remote-groups']) : undefined;
			socket.isAuthenticated = (remoteUser !== undefined);
			socket.isAdmin = (socket.isAuthenticated && remoteGroups?.split(',')?.includes('admins')) || false;
			socket.username = (socket.isAuthenticated ? remoteUser : 'guest');
			next();
		});
	}

	#setupConnectionHandlers() {
		this.#nsp.on('connection', (socket) => {
			if (typeof this.onConnection === 'function') {
				this.onConnection(socket);
			}
			this.#plugins.forEach((plugin) => {
				if (typeof plugin.onConnection === 'function') {
					plugin.onConnection(socket, this);
				}
			});
			
			socket.on('disconnect', () => {
				if (typeof this.onDisconnect === 'function') {
					this.onDisconnect(socket);
				}
				this.#plugins.forEach((plugin) => {
					if (typeof plugin.onDisconnect === 'function') {
						plugin.onDisconnect(socket, this);
					}
				});
			});
		});
	}

	async #processJob(job) {
		for (const plugin of this.#plugins) {
			if (plugin.jobs && typeof plugin.jobs[job.name] === 'function') {
				return await plugin.jobs[job.name](job, this);
			}
		}
		throw new Error(`[${this.#name}] Unhandled job: ${job.name}`);
	}

	#wireWorkerEvents(worker) {
		worker.on('completed', async (job, result) => {
			if (job) {
				await this.updateJobProgress(job, result);
			}
		});
		worker.on('failed', async (job) => {
			if (job) {
				await this.updateJobProgress(job, ``);
			}
		});
		worker.on('error', (error) => {
			console.error(error);
		});
	}

	#setupQueues() {
		const connection = {
			host: config.redis.host,
			port: config.redis.port
		};
		const defaultOpts = {
			removeOnComplete: 100,
			removeOnFail: 100
		};

		const queueName = getQueueName(this.#name);
		this.#queue = new Queue(queueName, {
			connection,
			defaultJobOptions: defaultOpts
		});
		this.#worker = new Worker(
			queueName,
			async (job) => {
				return await this.#processJob(job);
			},
			{ connection }
		);
		this.#wireWorkerEvents(this.#worker);

		const scheduledName = getScheduledQueueName(this.#name);
		this.#scheduledQueue = new Queue(scheduledName, {
			connection,
			defaultJobOptions: defaultOpts
		});
		this.#scheduledWorker = new Worker(
			scheduledName,
			async (job) => {
				return await this.#processJob(job);
			},
			{ connection }
		);
		this.#wireWorkerEvents(this.#scheduledWorker);
	}

	async #loadPlugins() {
		const pluginDir = path.join(__dirname, this.#name);
		const pluginFiles = fs.readdirSync(pluginDir)?.filter((file) => { return file.endsWith('.js') && file !== 'index.js'; });
		for (const file of pluginFiles) {
			try {
				const module = await import(pathToFileURL(path.join(pluginDir, file)).href);
				const plugin = module.default;
				if (!plugin || typeof plugin !== 'object') {
					console.warn(`[${this.#name}] Invalid plugin in ${file}: not an object`);
					continue;
				}
				this.#plugins.push(plugin);
				if (typeof plugin.register === 'function') {
					plugin.register(this);
				}
			} catch (error) {
				console.error(`[${this.#name}] Failed to load plugin ${file}:`, error);
			}
		}
	}
}

export default BaseModule;
