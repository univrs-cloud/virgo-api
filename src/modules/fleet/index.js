import { io } from 'socket.io-client';
import config from '../../../config.js';
import eventEmitter from '../../utils/event_emitter.js';
import DataService from '../../database/data_service.js';

let fleetSocket = null;
let localBridgeSocket = null;
let heartbeatInterval = null;
let activeNodeId = null;
let activeToken = null;

function disconnect() {
	const wasActive = Boolean(fleetSocket);

	clearInterval(heartbeatInterval);
	heartbeatInterval = null;
	activeNodeId = null;
	activeToken = null;
	fleetSocket?.offAny();
	fleetSocket?.disconnect();
	fleetSocket = null;
	localBridgeSocket?.offAny();
	localBridgeSocket?.disconnect();
	localBridgeSocket = null;

	// Explicit teardown (e.g. disabling fleet, or reconnecting with new credentials before this
	// connection ever reached a 'connect'/'disconnect' state of its own): notify listeners directly,
	// since the native socket events won't fire on their own in that case.
	if (wasActive) {
		eventEmitter.emit('fleet:status', { connected: false });
	}
}

function startHeartbeat(nodeId) {
	clearInterval(heartbeatInterval);
	heartbeatInterval = setInterval(() => {
		if (fleetSocket?.connected && nodeId) {
			fleetSocket.emit('node:heartbeat', { nodeId });
		}
	}, 25000);
}

function attachLoopbackBridge() {
	if (localBridgeSocket) {
		return;
	}

	localBridgeSocket = io('/host', {
		path: '/api',
		reconnection: true
	});

	const forwardToFleet = (event, ...args) => {
		if (fleetSocket?.connected) {
			fleetSocket.emit(event, ...args);
		}
	};
	const forwardToLocal = (event, ...args) => {
		if (localBridgeSocket?.connected) {
			localBridgeSocket.emit(event, ...args);
		}
	};

	const wireFleet = () => {
		fleetSocket.onAny(forwardToLocal);
	};
	const wireLocal = () => {
		localBridgeSocket.onAny(forwardToFleet);
	};

	if (fleetSocket.connected) {
		wireFleet();
	} else {
		fleetSocket.once('connect', wireFleet);
	}
	if (localBridgeSocket.connected) {
		wireLocal();
	} else {
		localBridgeSocket.once('connect', wireLocal);
	}
}

function openAuthenticatedConnection(fleetConfiguration) {
	const token = fleetConfiguration.token;
	const nodeId = fleetConfiguration.nodeId;

	disconnect();
	activeNodeId = nodeId;
	activeToken = token;

	fleetSocket = io(`${config.fleet.url}/node`, {
		path: '/api/fleet',
		reconnection: true,
		reconnectionAttempts: Infinity,
		reconnectionDelay: 1000,
		reconnectionDelayMax: 5000,
		auth: {
			role: 'node',
			secret: token
		}
	});

	fleetSocket.on('connect', () => {
		console.log(`[fleet] connected as ${activeNodeId}`);
		attachLoopbackBridge();
		eventEmitter.emit('fleet:status', { connected: true });
	});

	fleetSocket.on('disconnect', (reason) => {
		console.warn(`[fleet] disconnected from fleet (${reason})`);
		eventEmitter.emit('fleet:status', { connected: false });
	});

	fleetSocket.on('connect_error', (error) => {
		console.error('[fleet] connection error:', error.message);
	});

	startHeartbeat(nodeId);
}

/** Opens (or reopens) the persistent authenticated connection for an enabled, registered fleet configuration; disconnects otherwise. This is a one-shot attempt: the connection itself retries indefinitely on its own once opened. */
function connect(fleetConfiguration = { enabled: false }) {
	if (!config.fleet.url || !fleetConfiguration.enabled || !fleetConfiguration.token) {
		disconnect();
		return;
	}

	if (activeToken === fleetConfiguration.token && fleetSocket) {
		return;
	}
	openAuthenticatedConnection(fleetConfiguration);
}

/** Owns the outbound connection to the fleet server. It has no socket namespace of its own: it reacts to `fleet:sync` events (emitted by `configuration/fleet.js` whenever the fleet configuration may have changed) by reading the current configuration and (re)connecting accordingly, and reports its live status back via `fleet:status` events. */
class FleetModule {
	constructor() {
		eventEmitter.on('fleet:sync', async () => {
			try {
				const configuration = await DataService.getConfiguration();
				connect(configuration?.fleet);
			} catch (error) {
				console.error('[fleet] Failed to sync connection:', error);
			}
		});
	}
}

export default () => {
	return new FleetModule();
};
