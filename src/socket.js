import { Server } from 'socket.io';
import * as readiness from './utils/readiness.js';
import * as trustedProxy from './utils/trusted_proxy.js';
import { isLoopbackAddress } from './utils/private_address.js';

let io = null;

const isSameOrigin = (request) => {
	const origin = request?.headers?.origin;
	if (!origin) {
		return true;
	}

	const forwarded = (trustedProxy.isFromTrustedProxy(request.socket?.remoteAddress) ? request.headers['x-forwarded-host'] : undefined);
	const host = (forwarded || request.headers.host || '').split(',')[0].trim();
	if (!host) {
		return false;
	}

	try {
		return new URL(origin).host === host;
	} catch (error) {
		return false;
	}
};

const gateStarting = (server) => {
	const wrap = (event, deny) => {
		const listeners = server.listeners(event).slice();
		server.removeAllListeners(event);
		server.on(event, async (request, ...rest) => {
			if (!isLoopbackAddress(request.socket?.remoteAddress) && await readiness.isStarting()) {
				deny(request, ...rest);
				return;
			}

			listeners.forEach((listener) => { listener.call(server, request, ...rest); });
		});
	};

	wrap('request', (request, response) => {
		response.writeHead(503, { 'retry-after': '5', 'content-type': 'application/json' });
		response.end(JSON.stringify({ message: 'Starting' }));
	});
	wrap('upgrade', (request, socket) => {
		socket.destroy();
	});
};

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}
	
	io = new Server(server, {
		path: '/api',
		allowRequest: (request, callback) => { callback(null, isSameOrigin(request)); }
	});
	gateStarting(server);

	return io;
};

const getIO = () => {
	if (!io) {
		throw new Error('Socket.IO not initialized. Call initializeSocket first.');
	}
	return io;
};

export {
	initializeSocket,
	getIO
};
