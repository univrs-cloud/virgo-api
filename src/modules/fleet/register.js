import { io } from 'socket.io-client';
import si from 'systeminformation';
import config from '../../../config.js';

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
	if (!config.fleet.url) {
		return Promise.reject(new Error('Fleet is not configured on this server'));
	}

	return new Promise((resolve, reject) => {
		const fleetSocket = io(`${config.fleet.url}/node`, {
			path: '/api',
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

const onRegister = (module) => {
	module.eventEmitter.on('fleet:register', async ({ email, password } = {}) => {
		try {
			const response = await register({ email, password });
			module.eventEmitter.emit('fleet:registered', {
				email,
				nodeId: response.nodeId,
				token: response.token
			});
		} catch (error) {
			console.error('[fleet] registration failed:', error.message);
			module.eventEmitter.emit('fleet:register:error', { error: error.message });
		}
	});
};

export default {
	name: 'register',
	register: onRegister
};
