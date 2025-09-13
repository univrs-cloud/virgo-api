const { Queue, Worker } = require('bullmq');

class BaseEmitter {
	#name;
	#io;
	#nsp;
	#state = {};
	#queue;
	#worker;

	constructor(io, name, options = {}) {
		this.#name = name;
		this.#io = io;
		this.#nsp = this.#io.of(`/${this.#name}`);
		this.#setupMiddleware();
		this.#setupConnectionHandlers();
		this.#setupQueues();
	}

	getNsp() {
		return this.#nsp;
	}

	getState(key) {
		return this.#state[key];
	}

	setState(key, state) {
		this.#state[key] = state;
	}

	async addJob(name, data) {
		try {
			await this.#queue.add(name, data);
		} catch (error) {
			console.error('Error starting job:', error);
		}
	}

	async addJobSchedule(name, pattern) {
		try {
			await this.#queue.upsertJobScheduler(
				name,
				pattern,
				{
					opts: {
						removeOnComplete: 1
					}
				}
			);
		} catch (error) {
			console.error('Error starting job:', error);
		}
	}

	async processJob(job) {
		throw new Error('processJob must be implemented by subclasses');
	}

	async updateJobProgress(job, message) {
		const state = await job.getState();
		await job.updateProgress({ state, message });
	}

	onConnection(socket) {
	}
	
	onDisconnect(socket) {
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
			this.onConnection(socket);
			
			socket.on('disconnect', () => {
				this.onDisconnect(socket);
			});
		});
	}

	#setupQueues() {
		this.#queue = new Queue(`${this.#name}-jobs`);
		this.#worker = new Worker(
			`${this.#name}-jobs`,
			async (job) => {
				return await this.processJob(job);
			},
			{
				connection: {
					host: 'localhost',
					port: 6379,
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
}

module.exports = BaseEmitter;
