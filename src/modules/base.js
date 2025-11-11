const fs = require('fs');
const path = require('path');
const { Queue, Worker } = require('bullmq');
const { getIO } = require('../socket');
const eventEmitter = require('../utils/event_emitter');
const config = require('../../config');

class BaseModule {
	#name;
	#io;
	#nsp;
	#eventEmitter;
	#state = {};
	#queue;
	#worker;
	#plugins = [];

	constructor(name) {
		this.#name = name;
		this.#io = getIO();
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
			await this.#queue.upsertJobScheduler(
				name,
				pattern,
				{
					name: name,
					opts: {
						removeOnComplete: 1
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

	#setupMiddleware() {
		this.#nsp.use((socket, next) => {
			socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
			socket.isAdmin = (socket.isAuthenticated ? socket.handshake.headers['remote-groups']?.split(',')?.includes('admins') : false);
			socket.username = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
			next();
		});
	}

	#setupConnectionHandlers() {
		this.#nsp.on('connection', (socket) => {
			socket.join(`user:${socket.username}`);

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

	#setupQueues() {
		this.#queue = new Queue(`${this.#name}-jobs`);
		this.#worker = new Worker(
			`${this.#name}-jobs`,
			async (job) => {
				return await this.#processJob(job);
			},
			{
				connection: {
					host: config.redis.host,
					port: config.redis.port
				}
			}
		);
		this.#worker.on('completed', async (job, result) => {
			if (job) {
				await this.updateJobProgress(job, result);
			}
		});
		this.#worker.on('failed', async (job, error) => {
			if (job) {
				await this.updateJobProgress(job, ``);
			}
		});
		this.#worker.on('error', (error) => {
			console.error(error);
		});
	}

	#loadPlugins() {
		const pluginDir = path.join(__dirname, this.#name);
		const pluginFiles = fs.readdirSync(pluginDir)?.filter((file) => { return file.endsWith('.js') && file !== 'index.js'; });
		for (const file of pluginFiles) {
			try {
				const plugin = require(path.join(pluginDir, file));
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

module.exports = BaseModule;
