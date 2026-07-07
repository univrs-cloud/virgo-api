import fs from 'fs/promises';
import path from 'path';
import { io as ioClient } from 'socket.io-client';
import serverConfig from '../../config.js';
import { folderPath as distFolder } from '../controllers/static.js';

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.txt': 'text/plain; charset=utf-8'
};

const getContentType = (filePath) => {
	return contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
};

const resolveDistPath = (assetPath) => {
	const cleaned = decodeURIComponent(assetPath).split('?')[0].split('#')[0];
	const trimmed = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
	const target = path.resolve(distFolder, trimmed || 'index.html');
	if (!target.startsWith(distFolder)) {
		return null;
	}
	return target;
};

const handleAssetRequest = async (socket, { requestId, path: assetPath }) => {
	try {
		const target = resolveDistPath(assetPath || '/index.html');
		if (!target) {
			socket.emit('proxy:asset:response', { requestId, status: 400, error: 'Invalid path' });
			return;
		}
		const body = await fs.readFile(target);
		socket.emit('proxy:asset:response', {
			requestId,
			status: 200,
			contentType: getContentType(target),
			body: body.toString('base64')
		});
	} catch (error) {
		socket.emit('proxy:asset:response', {
			requestId,
			status: error.code === 'ENOENT' ? 404 : 500,
			error: error.message
		});
	}
};

const openInternalSocket = ({ namespace, user }) => {
	const url = `http://127.0.0.1:${serverConfig.server.port}${namespace}`;
	return ioClient(url, {
		path: '/api',
		transports: ['websocket'],
		reconnection: false,
		extraHeaders: {
			'remote-user': user?.email || 'fleet-proxy',
			'remote-groups': (user?.groups || ['admins']).join(',')
		}
	});
};

const attachProxyHandlers = (fleetSocket) => {
	if (!fleetSocket || fleetSocket.data?.proxyAttached) {
		return;
	}
	fleetSocket.data = fleetSocket.data || {};
	fleetSocket.data.proxyAttached = true;
	const sessions = new Map();

	fleetSocket.on('proxy:asset', (payload) => {
		handleAssetRequest(fleetSocket, payload || {});
	});

	fleetSocket.on('proxy:open', ({ sessionId, namespace, user } = {}) => {
		if (!sessionId || !namespace) {
			return;
		}
		if (sessions.has(sessionId)) {
			return;
		}
		const client = openInternalSocket({ namespace, user });
		sessions.set(sessionId, client);
		client.onAny((event, ...args) => {
			if (fleetSocket.connected) {
				fleetSocket.emit('proxy:event', { sessionId, event, args });
			}
		});
		client.on('disconnect', () => {
			sessions.delete(sessionId);
			if (fleetSocket.connected) {
				fleetSocket.emit('proxy:close', { sessionId });
			}
		});
	});

	fleetSocket.on('proxy:event', ({ sessionId, event, args } = {}) => {
		const client = sessions.get(sessionId);
		if (client?.connected) {
			client.emit(event, ...(Array.isArray(args) ? args : []));
		}
	});

	fleetSocket.on('proxy:close', ({ sessionId } = {}) => {
		const client = sessions.get(sessionId);
		if (client) {
			sessions.delete(sessionId);
			client.disconnect();
		}
	});

	fleetSocket.on('disconnect', () => {
		for (const client of sessions.values()) {
			client.disconnect();
		}
		sessions.clear();
	});
};

export {
	attachProxyHandlers
};
