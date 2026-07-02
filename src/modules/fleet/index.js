import { io } from 'socket.io-client';
import si from 'systeminformation';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import eventEmitter from '../../utils/event_emitter.js';

let fleetSocket = null;
let localBridgeSocket = null;
let heartbeatInterval = null;
let activeNodeId = null;
let activeToken = null;
let registering = false;
let pendingCredentials = null;

function disconnect() {
	clearInterval(heartbeatInterval);
	heartbeatInterval = null;
	activeNodeId = null;
	activeToken = null;
	registering = false;
	pendingCredentials = null;
	fleetSocket?.offAny();
	fleetSocket?.disconnect();
	fleetSocket = null;
	localBridgeSocket?.offAny();
	localBridgeSocket?.disconnect();
	localBridgeSocket = null;
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

async function registerNode(credentials) {
	const { serial } = await si.system();
	const serialNumber = String(serial || '').trim();
	if (!serialNumber) {
		throw new Error('Unable to read system serial number');
	}

	return new Promise((resolve, reject) => {
		fleetSocket.emit('node:register', {
			serialNumber,
			name: serialNumber,
			email: credentials.email,
			password: credentials.password
		}, async (response) => {
			if (!response?.ok) {
				reject(new Error(response?.error || 'Node registration failed'));
				return;
			}

			const configuration = await DataService.getConfiguration();
			const current = configuration?.fleet || {};
			await DataService.setConfiguration('fleet', {
				...current,
				enabled: true,
				email: credentials.email,
				nodeId: response.nodeId,
				token: response.token
			});
			pendingCredentials = null;
			eventEmitter.emit('configuration:updated');
			resolve(response);
		});
	});
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
	});

	fleetSocket.on('disconnect', (reason) => {
		console.warn(`[fleet] disconnected from fleet (${reason})`);
	});

	fleetSocket.on('connect_error', (error) => {
		console.error('[fleet] connection error:', error.message);
	});

	startHeartbeat(nodeId);
}

async function openRegistrationConnection(credentials) {
	if (registering || fleetSocket) {
		return;
	}

	registering = true;

	fleetSocket = io(`${config.fleet.url}/node`, {
		path: '/api/fleet',
		reconnection: false,
		auth: {
			role: 'node'
		}
	});

	fleetSocket.on('connect', async () => {
		try {
			const response = await registerNode(credentials);
			console.log(`[fleet] node registered as ${response.nodeId}`);
		} catch (error) {
			console.error('[fleet] node registration failed:', error.message);
			const configuration = await DataService.getConfiguration();
			const current = configuration?.fleet || {};
			await DataService.setConfiguration('fleet', {
				...current,
				enabled: false
			});
			eventEmitter.emit('configuration:updated');
			disconnect();
		} finally {
			registering = false;
		}
	});

	fleetSocket.on('connect_error', (error) => {
		console.error('[fleet] registration connection error:', error.message);
		registering = false;
		disconnect();
	});
}

async function sync() {
	if (!config.fleet.url) {
		disconnect();
		return;
	}

	const configuration = await DataService.getConfiguration();
	const fleetConfiguration = configuration?.fleet || { enabled: false };

	if (!fleetConfiguration.enabled) {
		disconnect();
		return;
	}

	if (fleetConfiguration.token) {
		if (activeToken === fleetConfiguration.token && fleetSocket) {
			return;
		}
		openAuthenticatedConnection(fleetConfiguration);
		return;
	}

	if (pendingCredentials) {
		await openRegistrationConnection(pendingCredentials);
	}
}

class FleetModule {
	constructor() {
		eventEmitter.on('fleet:register', (credentials) => {
			pendingCredentials = credentials;
			sync().catch((error) => {
				console.error('[fleet] registration sync error:', error);
			});
		});
		eventEmitter.on('configuration:updated', () => {
			sync().catch((error) => {
				console.error('[fleet] sync error:', error);
			});
		});
		sync().catch((error) => {
			console.error('[fleet] startup sync error:', error);
		});
	}
}

export default () => {
	return new FleetModule();
};
