import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Queue, Worker } from 'bullmq';
import config from '../../config.js';
import eventEmitter from '../utils/event_emitter.js';
import { digest } from '../utils/state_digest.js';
import * as socket from '../socket.js';
import * as setup from '../utils/setup_state.js';
import * as trustedProxy from '../utils/trusted_proxy.js';
import * as identity from '../utils/identity.js';
import * as nlp from '../utils/nlp.js';
import { isPrivateAddress } from '../utils/private_address.js';
import { getQueueName, getScheduledQueueName } from '../queues.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// How long a socket goes on trusting the identity it resolved before checking it again.
const IDENTITY_TTL = 30000;
// What a socket is told before anyone knows who is holding it: the three answers the shell reads to
// decide which app to build — including the login screen it builds for a stranger. Everything else
// waits until the node knows the socket belongs to somebody, or to somewhere it lets in unasked.
const PUBLIC_EVENTS = ['role', 'host:setupCompleted', 'host:update'];

const isVisible = (socket, event) => {
	return (PUBLIC_EVENTS.includes(event) || socket.isAuthenticated || socket.isLocal);
};

/** The client, as opposed to whatever forwarded it. The last hop a trusted proxy recorded is the one
 * it accepted the connection from; anything to the left of that the client wrote itself. */
const clientAddress = (socket) => {
	const forwarded = (trustedProxy.isFromTrustedProxy(socket.conn?.remoteAddress) ? socket.handshake.headers['x-forwarded-for'] : undefined);
	const hops = (forwarded || '').split(',').map((hop) => { return hop.trim(); }).filter(Boolean);
	return (hops.length > 0 ? hops[hops.length - 1] : socket.conn?.remoteAddress);
};

class BaseModule {
	#name;
	#io;
	#nsp;
	#eventEmitter;
	#state = {};
	#digests = new Map();
	#queue;
	#worker;
	#scheduledQueue;
	#scheduledWorker;
	#plugins = [];

	constructor(name) {
		this.#name = name;
		this.#io = socket.getIO();
		this.#nsp = this.#io.of(`/${this.#name}`);
		// Namespace-wide sends are delivered socket by socket, so they pass through the same wrapper as
		// everything else: the adapter would carry them past the only place that knows who is listening.
		this.#nsp.emit = (event, ...args) => {
			for (const socket of this.#nsp.sockets.values()) {
				socket.emit(event, ...args);
			}
			return true;
		};
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

	/**
	 * Broadcast only when the payload differs from the one last sent for this event, so a poll that
	 * finds nothing new costs nothing on the wire. State is still written unconditionally, so
	 * onConnection replays keep late joiners correct regardless of what was suppressed.
	 * @param {string} event - The event name, also the digest key unless `key` is given
	 * @param {*} payload - The payload to emit
	 * @param {object} [options]
	 * @param {string} [options.key] - Digest key, for events emitted from more than one payload shape
	 * @param {Function} [options.normalize] - Projection applied before digesting only, to drop volatile fields
	 * @param {Function} [options.filter] - Per-socket predicate; omit to broadcast to the namespace
	 * @param {boolean} [options.sortArrays] - Digest arrays as sets, for sources that return them reordered
	 * @returns {boolean} - Whether the payload changed and was emitted
	 */
	emitChanged(event, payload, { key = event, normalize, filter, sortArrays } = {}) {
		const next = digest(normalize ? normalize(payload) : payload, { sortArrays });
		if (this.#digests.get(key) === next) {
			return false;
		}

		this.#digests.set(key, next);
		for (const socket of this.#nsp.sockets.values()) {
			if (!filter || filter(socket)) {
				socket.emit(event, payload);
			}
		}
		return true;
	}

	#setupMiddleware() {
		this.#nsp.use(async (socket, next) => {
			const cookie = socket.handshake.headers.cookie;
			const fqdn = socket.handshake.headers['x-forwarded-host'] ?? socket.handshake.headers.host;
			// How a node identified users before the login screen moved into this app: the proxy asked
			// Authelia and passed the answer down. A session cookie outranks it, and where the proxy no
			// longer asks, it is all that is left.
			const fromHeaders = () => {
				const isTrusted = trustedProxy.isFromTrustedProxy(socket.conn?.remoteAddress);
				const remoteUser = isTrusted ? (socket.handshake.headers['remote-user'] ?? socket.handshake.auth?.['remote-user']) : undefined;
				const remoteGroups = isTrusted ? (socket.handshake.headers['remote-groups'] ?? socket.handshake.auth?.['remote-groups']) : undefined;
				return {
					isAuthenticated: (remoteUser !== undefined),
					isAdmin: (remoteUser !== undefined && remoteGroups?.split(',')?.includes('admins')) || false,
					username: remoteUser
				};
			};

			// One question answers both: who is holding this socket, and whether the network it came from
			// is let in without anybody holding it. Setup is not asked at all — an appliance being set up
			// answers on an address and a port of its own, with nothing installed to ask and nothing yet
			// to keep from anyone; the elevation below covers it, and ends when setup does.
			const address = clientAddress(socket);
			const resolve = async () => {
				if (!setup.isCompleted()) {
					return identity.ANONYMOUS;
				}

				const account = await identity.getIdentity({ cookie, fqdn, clientAddress: address });
				return (account.isAuthenticated ? account : { ...fromHeaders(), isLocal: account.isLocal || isPrivateAddress(address) });
			};

			let account = await resolve();
			// A session ends on the node's clock, not this connection's, and a socket outlives both. So
			// the answer is renewed as the socket is used: a read past its age starts the next check and
			// keeps going with what it has, since nothing here can wait.
			let resolvedAt = Date.now();
			const renew = () => {
				if ((Date.now() - resolvedAt) < IDENTITY_TTL) {
					return;
				}

				resolvedAt = Date.now();
				resolve().then((current) => { account = current; }).catch(() => {});
			};

			// First-run setup has no account to authenticate against, so the wizard's sockets act as an
			// admin. Resolved on every read rather than frozen at connect, so sockets opened during setup
			// lose the elevation the moment it completes instead of keeping it for their whole lifetime.
			Object.defineProperty(socket, 'isAuthenticated', {
				get: () => { renew(); return account.isAuthenticated || !setup.isCompleted(); },
				configurable: true
			});
			Object.defineProperty(socket, 'isAdmin', {
				get: () => { renew(); return account.isAdmin || !setup.isCompleted(); },
				configurable: true
			});
			Object.defineProperty(socket, 'isLocal', {
				get: () => { renew(); return account.isLocal || !setup.isCompleted(); },
				configurable: true
			});
			Object.defineProperty(socket, 'username', {
				get: () => { renew(); return (account.isAuthenticated ? account.username : (setup.isCompleted() ? 'guest' : 'setup')); },
				configurable: true
			});
			next();
		});
	}

	#setupConnectionHandlers() {
		this.#nsp.on('connection', (socket) => {
			// The one place what a socket may hear is decided. Modules emit as they always have; a socket
			// belonging to nobody, from a network the node does not let in unasked, is simply not told.
			const emit = socket.emit.bind(socket);
			socket.emit = (event, ...args) => {
				return (isVisible(socket, event) ? emit(event, ...args) : false);
			};

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
