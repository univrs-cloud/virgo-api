import { io } from 'socket.io-client';
import si from 'systeminformation';
import fleetConfig from '../../../config.js';
import DataService from '../../database/data_service.js';

async function registerNode(fleetSocket, credentials) {
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
		}, (response) => {
			if (!response?.ok) {
				reject(new Error(response?.error || 'Node registration failed'));
				return;
			}
			resolve(response);
		});
	});
}

/** One-shot registration with the fleet server: opens a temporary connection and registers this node, resolving with the resulting `{ nodeId, token }`. */
function register(credentials) {
	if (!fleetConfig.fleet.url) {
		return Promise.reject(new Error('Fleet is not configured on this server'));
	}

	return new Promise((resolve, reject) => {
		const fleetSocket = io(`${fleetConfig.fleet.url}/node`, {
			path: '/api/fleet',
			reconnection: false,
			auth: {
				role: 'node'
			}
		});

		fleetSocket.on('connect', async () => {
			try {
				const response = await registerNode(fleetSocket, credentials);
				fleetSocket.disconnect();
				resolve(response);
			} catch (error) {
				fleetSocket.disconnect();
				reject(error);
			}
		});

		fleetSocket.on('connect_error', (error) => {
			fleetSocket.disconnect();
			reject(new Error(error.message || 'Unable to reach fleet server'));
		});
	});
}

const updateFleetConfiguration = async (job, module) => {
	const configuration = await DataService.getConfiguration();
	const current = configuration?.fleet || {};
	const enabled = Boolean(job.data.config?.enabled);
	const email = String(job.data.config?.email || current.email || '').trim().toLowerCase() || null;

	if (enabled && !current.token && (!email || !job.data.config?.password)) {
		throw new Error('Fleet email and password are required');
	}

	let updated;
	let message;
	if (enabled && !current.token) {
		await module.updateJobProgress(job, 'Registering with fleet...');
		let response;
		try {
			response = await register({ email, password: job.data.config.password });
		} catch (error) {
			throw new Error(`Unable to register with fleet: ${error.message}`);
		}
		updated = {
			...current,
			enabled: true,
			email,
			nodeId: response.nodeId,
			token: response.token
		};
		message = 'Registered with fleet.';
	} else {
		updated = {
			...current,
			enabled,
			email
		};
		message = (enabled ? 'Fleet configuration saved.' : 'Fleet disabled.');
	}

	await DataService.setConfiguration('fleet', updated);
	module.eventEmitter.emit('configuration:updated');

	if (updated.enabled) {
		await module.updateJobProgress(job, 'Connecting to fleet...');
	}
	module.eventEmitter.emit('fleet:sync');

	return message;
};

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('fleet:update', { config, username: socket.username });
	});
};

/** Plugin lifecycle hook: reconnects using previously stored credentials at startup. */
const onRegister = (module) => {
	module.eventEmitter.emit('fleet:sync');
};

export default {
	name: 'fleet',
	onConnection,
	register: onRegister,
	jobs: {
		'fleet:update': updateFleetConfiguration
	}
};
