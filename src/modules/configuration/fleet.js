import si from 'systeminformation';
import { io } from 'socket.io-client';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import { attachProxyHandlers } from '../../utils/fleet_proxy.js';
import { setFleetRuntimeState, resetFleetRuntimeState } from '../../utils/fleet_state.js';

const fleetUrl = config.fleet.url;
const AUTH_FAILED_ERROR = 'Node authentication failed';
let fleetSocket = null;
let fleetModule = null;

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
		reconnectionDelayMax: 10000
	});
	fleetSocket.on('connect', () => {
		setFleetRuntimeState({ connected: true, authFailed: false });
		attachProxyHandlers(fleetSocket);
		broadcastConfigurationUpdate();
	});
	fleetSocket.on('fleet:unregister', async (ack = () => {}) => {
		try {
			await DataService.deleteConfiguration('fleet');
			broadcastConfigurationUpdate();
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error.message });
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
				if (!response?.ok) {
					reject(new Error(response?.error || 'Fleet registration failed'));
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
			await connect({ token: fleet.token, nodeId: fleet.nodeId });
		}
	} catch (error) {
		console.error('Error starting fleet connection:', error);
	}
};

const register = (module) => {
	fleetModule = module;
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
