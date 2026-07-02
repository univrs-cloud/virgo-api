import { io } from 'socket.io-client';
import config from '../../../config.js';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

class FleetModule extends BaseModule {
	#fleetSocket = null;
	#heartbeatInterval = null;
	#activeNodeId = null;
	#activeToken = null;
	/** sessionId -> local loopback socket. One per proxied client connection coming from the fleet. */
	#proxySessions = new Map();

	constructor() {
		super('fleet');

		this.eventEmitter.on('fleet:sync', async () => {
			try {
				const configuration = await DataService.getConfiguration();
				this.#connect(configuration?.fleet);
			} catch (error) {
				console.error('[fleet] Failed to sync connection:', error);
			}
		});
	}

	#closeProxySession(sessionId, notifyFleet) {
		const local = this.#proxySessions.get(sessionId);
		if (!local) {
			return;
		}
		this.#proxySessions.delete(sessionId);
		local.offAny();
		local.disconnect();
		if (notifyFleet && this.#fleetSocket?.connected) {
			this.#fleetSocket.emit('proxy:close', { sessionId });
		}
	}

	#closeAllProxySessions() {
		for (const sessionId of [...this.#proxySessions.keys()]) {
			this.#closeProxySession(sessionId, false);
		}
	}

	#disconnect() {
		const wasActive = Boolean(this.#fleetSocket);

		clearInterval(this.#heartbeatInterval);
		this.#heartbeatInterval = null;
		this.#activeNodeId = null;
		this.#activeToken = null;
		this.#closeAllProxySessions();
		this.#fleetSocket?.offAny();
		this.#fleetSocket?.disconnect();
		this.#fleetSocket = null;

		// Explicit teardown (e.g. disabling fleet, or reconnecting with new credentials before this
		// connection ever reached a 'connect'/'disconnect' state of its own): notify listeners directly,
		// since the native socket events won't fire on their own in that case.
		if (wasActive) {
			this.eventEmitter.emit('fleet:status', { connected: false });
		}
	}

	#startHeartbeat(nodeId) {
		clearInterval(this.#heartbeatInterval);
		this.#heartbeatInterval = setInterval(() => {
			if (this.#fleetSocket?.connected && nodeId) {
				this.#fleetSocket.emit('node:heartbeat', { nodeId });
			}
		}, 25000);
	}

	/** Wires the multiplexed proxy tunnel: the fleet relays any namespace a client asks for, and the node
	 * decides how to service it by opening a loopback connection to its own local module of that name. */
	#attachProxyBridge() {
		this.#fleetSocket.on('proxy:open', ({ sessionId, namespace } = {}) => {
			if (!sessionId || !namespace) {
				return;
			}
			this.#closeProxySession(sessionId, false);

			const local = io(namespace, {
				path: '/api',
				reconnection: false
			});
			this.#proxySessions.set(sessionId, local);

			local.onAny((event, ...args) => {
				if (this.#fleetSocket?.connected) {
					this.#fleetSocket.emit('proxy:event', { sessionId, event, args });
				}
			});

			local.on('disconnect', () => {
				this.#closeProxySession(sessionId, true);
			});
		});

		this.#fleetSocket.on('proxy:event', ({ sessionId, event, args } = {}) => {
			const local = this.#proxySessions.get(sessionId);
			local?.emit(event, ...(Array.isArray(args) ? args : []));
		});

		this.#fleetSocket.on('proxy:close', ({ sessionId } = {}) => {
			this.#closeProxySession(sessionId, false);
		});
	}

	#openAuthenticatedConnection(fleetConfiguration) {
		const token = fleetConfiguration.token;
		const nodeId = fleetConfiguration.nodeId;

		this.#disconnect();
		this.#activeNodeId = nodeId;
		this.#activeToken = token;

		this.#fleetSocket = io(`${config.fleet.url}/node`, {
			path: '/api',
			reconnection: true,
			reconnectionAttempts: Infinity,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			auth: {
				role: 'node',
				secret: token
			}
		});

		this.#attachProxyBridge();

		this.#fleetSocket.on('connect', () => {
			console.log(`[fleet] connected as ${this.#activeNodeId}`);
			this.eventEmitter.emit('fleet:status', { connected: true });
		});

		this.#fleetSocket.on('disconnect', (reason) => {
			console.warn(`[fleet] disconnected from fleet (${reason})`);
			this.#closeAllProxySessions();
			this.eventEmitter.emit('fleet:status', { connected: false });
		});

		this.#fleetSocket.on('connect_error', (error) => {
			console.error('[fleet] connection error:', error.message);
		});

		this.#startHeartbeat(nodeId);
	}

	/** Opens (or reopens) the persistent authenticated connection for an enabled, registered fleet configuration; disconnects otherwise. This is a one-shot attempt: the connection itself retries indefinitely on its own once opened. */
	#connect(fleetConfiguration = { enabled: false }) {
		if (!config.fleet.url || !fleetConfiguration.enabled || !fleetConfiguration.token) {
			this.#disconnect();
			return;
		}

		if (this.#activeToken === fleetConfiguration.token && this.#fleetSocket) {
			return;
		}
		this.#openAuthenticatedConnection(fleetConfiguration);
	}
}

export default () => {
	return new FleetModule();
};
