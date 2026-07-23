import si from 'systeminformation';
import { io } from 'socket.io-client';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import { attachProxyHandlers } from '../../utils/fleet_proxy.js';
import { setFleetRuntimeState, resetFleetRuntimeState } from '../../utils/fleet_state.js';

const fleetUrl = config.fleet.url;
const AUTH_FAILED_ERROR = 'Node authentication failed';
// A mass power event brings many nodes back at once; without a spread they'd all open their
// control socket in the same tick and hammer the fleet server (each connect is a serialised
// SQLite write). Delay the boot-time auto-connect by a random offset in this window so the
// reconnect load arrives smeared across time instead of as a single spike.
const STARTUP_JITTER_MS = 30000;
let fleetSocket = null;
let fleetModule = null;
// Each matches its source event: system is host:updates, apps is app:updates (array | [] | false).
let lastSystemUpdates = false;
let lastAppUpdates = false;
let lastUpdate = null;
let lastUpdateSignature = null;
let lastStorage = false;

const reportUpdatesToFleet = () => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:updates', { system: lastSystemUpdates, apps: lastAppUpdates });
	}
};

const reportStorageToFleet = () => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:storage', lastStorage);
	}
};

const fleetUpdate = () => {
	const state = lastUpdate?.state;
	if (state === 'running') {
		return { state, progress: lastUpdate.progress ?? null };
	}

	if (state === 'succeeded' || state === 'failed') {
		return { state };
	}
	
	return null;
};

const updateSignature = (update) => {
	if (!update) {
		return null;
	}

	return (update.state === 'running' ? `running:${update.progress?.stage ?? ''}:${update.progress?.percent ?? ''}` : update.state);
};

const reportUpdateToFleet = () => {
	if (!fleetSocket?.connected) {
		return;
	}

	const update = fleetUpdate();
	lastUpdateSignature = updateSignature(update);
	fleetSocket.emit('node:update', update);
};

const randomStartupDelay = () => {
	return Math.floor(Math.random() * STARTUP_JITTER_MS);
};

const broadcastConfigurationUpdate = () => {
	fleetModule?.eventEmitter?.emit('configuration:updated');
};

const getSystemInfo = async () => {
	const [system, osInfo] = await Promise.all([si.system(), si.osInfo()]);
	return {
		serialNumber: system?.serial || null,
		name: osInfo?.hostname || osInfo?.fqdn || null
	};
};

const connect = async ({ token, nodeId }) => {
	disconnect();
	resetFleetRuntimeState();
	fleetSocket = io(`${fleetUrl}/node`, {
		path: '/api',
		auth: { role: 'node', secret: token },
		reconnection: true,
		reconnectionDelay: 2000,
		reconnectionDelayMax: 10000,
		// Spread reconnection attempts: when the fleet server restarts, every node drops and
		// retries at once, so widen the backoff randomisation to de-correlate the retry storm.
		randomizationFactor: 0.75
	});
	fleetSocket.on('connect', () => {
		setFleetRuntimeState({ connected: true, authFailed: false });
		attachProxyHandlers(fleetSocket);
		broadcastConfigurationUpdate();
		reportUpdatesToFleet();
		reportUpdateToFleet();
		reportStorageToFleet();
	});
	fleetSocket.on('fleet:unregister', async (ack = () => {}) => {
		try {
			await DataService.deleteConfiguration('fleet');
			broadcastConfigurationUpdate();
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		} finally {
			disconnect();
		}
	});
	fleetSocket.on('disconnect', () => {
		setFleetRuntimeState({ connected: false });
		broadcastConfigurationUpdate();
	});
	fleetSocket.on('connect_error', (error) => {
		console.error('Fleet connection error:', error?.message || error);
		if (error?.message === AUTH_FAILED_ERROR) {
			setFleetRuntimeState({ connected: false, authFailed: true });
			fleetSocket?.disconnect();
			fleetSocket = null;
			broadcastConfigurationUpdate();
		}
	});
};

const disconnect = () => {
	if (fleetSocket) {
		fleetSocket.disconnect();
		fleetSocket = null;
	}
	resetFleetRuntimeState();
};

const registerNode = ({ email, password, serialNumber, name }) => {
	return new Promise((resolve, reject) => {
		const socket = io(`${fleetUrl}/node`, {
			path: '/api',
			auth: { role: 'node' },
			reconnection: false,
			timeout: 10000
		});
		socket.on('connect_error', (error) => {
			socket.disconnect();
			reject(new Error(error?.message || 'Failed to connect to fleet'));
		});
		socket.on('connect', () => {
			socket.emit('node:register', { serialNumber, name, email, password }, (response) => {
				socket.disconnect();
				if (response?.status !== 'succeeded') {
					reject(new Error(response?.message || 'Fleet registration failed'));
					return;
				}
				resolve({ nodeId: response.nodeId, token: response.token });
			});
		});
	});
};

const registerFleet = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, 'Registering with fleet...');

	const { serialNumber, name } = await getSystemInfo();
	if (!serialNumber) {
		throw new Error('Serial number is not available');
	}

	const { nodeId, token } = await registerNode({
		email: config.email,
		password: config.password,
		serialNumber,
		name
	});

	await DataService.setConfiguration('fleet', { enabled: true, nodeId, token, email: config.email });
	module.eventEmitter.emit('configuration:updated');
	await connect({ token, nodeId });
	return 'Fleet registered.';
};

const enableFleet = async (job, module) => {
	await module.updateJobProgress(job, 'Enabling fleet...');
	const configuration = await DataService.getConfiguration();
	const fleet = configuration?.fleet;
	if (!fleet?.token) {
		throw new Error('Fleet is not registered');
	}
	
	await DataService.setConfiguration('fleet', { ...fleet, enabled: true });
	module.eventEmitter.emit('configuration:updated');
	await connect({ token: fleet.token, nodeId: fleet.nodeId });
	return 'Fleet enabled.';
};

const disableFleet = async (job, module) => {
	await module.updateJobProgress(job, 'Disabling fleet...');
	const configuration = await DataService.getConfiguration();
	const fleet = configuration?.fleet;
	if (!fleet) {
		throw new Error('Fleet is not registered');
	}

	await DataService.setConfiguration('fleet', { ...fleet, enabled: false });
	module.eventEmitter.emit('configuration:updated');
	disconnect();
	return 'Fleet disabled.';
};

const startIfEnabled = async () => {
	try {
		const configuration = await DataService.getConfiguration();
		const fleet = configuration?.fleet;
		if (fleet?.enabled && fleet?.token) {
			// Jitter only the boot-time auto-connect; user-initiated register/enable stay immediate.
			const delay = randomStartupDelay();
			setTimeout(() => {
				connect({ token: fleet.token, nodeId: fleet.nodeId }).catch((error) => {
					console.error('Error starting fleet connection:', error);
				});
			}, delay);
		}
	} catch (error) {
		console.error('Error starting fleet connection:', error);
	}
};

const register = (module) => {
	fleetModule = module;
	module.eventEmitter.on('host:updates:updated', (updates) => {
		lastSystemUpdates = updates;
		reportUpdatesToFleet();
	});
	module.eventEmitter.on('app:updates:updated', (updates) => {
		lastAppUpdates = updates;
		reportUpdatesToFleet();
	});
	module.eventEmitter.on('host:update:updated', (update) => {
		lastUpdate = update;
		if (updateSignature(fleetUpdate()) === lastUpdateSignature) {
			return;
		}

		reportUpdateToFleet();
	});
	module.eventEmitter.on('host:storage:updated', (storage) => {
		lastStorage = storage;
		reportStorageToFleet();
	});
	startIfEnabled();
};

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:register', { config, username: socket.username });
	});

	socket.on('configuration:fleet:enable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:enable', { username: socket.username });
	});

	socket.on('configuration:fleet:disable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:disable', { username: socket.username });
	});
};

export default {
	name: 'fleet',
	register,
	onConnection,
	jobs: {
		'fleet:register': registerFleet,
		'fleet:enable': enableFleet,
		'fleet:disable': disableFleet
	}
};
