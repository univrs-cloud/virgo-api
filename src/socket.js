import { Server } from 'socket.io';
import * as readiness from './utils/readiness.js';
import { isLoopbackAddress } from './utils/private_address.js';

let io = null;

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
		cors: {
			origin: true,
			credentials: true
		}
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
