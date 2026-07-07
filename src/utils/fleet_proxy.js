import path from 'path';
import { io as ioClient } from 'socket.io-client';
import serverConfig from '../../config.js';
import { folderPath as distFolder } from '../controllers/static.js';

const HTTP_CHUNK_SIZE = 256 * 1024;
const activeHttpRequests = new Map();

const pickResponseHeaders = (headers) => {
	const selected = {};
	const contentType = headers.get('content-type');
	if (contentType) {
		selected['content-type'] = contentType;
	}
	return selected;
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

const buildLocalAssetUrl = (assetPath) => {
	const normalizedPath = assetPath?.startsWith('/') ? assetPath : `/${assetPath || 'index.html'}`;
	return new URL(normalizedPath, `http://${serverConfig.server.host}:${serverConfig.server.port}`);
};

const createAckGate = (socket, requestId) => {
	let nextSeq = 0;
	let pendingAck = null;
	let aborted = false;

	const abort = () => {
		aborted = true;
		if (pendingAck) {
			pendingAck.reject(new Error('Transfer aborted'));
			pendingAck = null;
		}
	};

	const onAck = ({ requestId: ackRequestId, seq } = {}) => {
		if (ackRequestId !== requestId || !pendingAck || pendingAck.seq !== seq) {
			return;
		}
		pendingAck.resolve();
		pendingAck = null;
	};

	const sendChunk = async (chunk) => {
		if (aborted) {
			throw new Error('Transfer aborted');
		}
		const seq = nextSeq++;
		const payload = Buffer.from(chunk);
		await new Promise((resolve, reject) => {
			pendingAck = { seq, resolve, reject };
			socket.emit('proxy:http:chunk', { requestId, seq }, payload);
		});
	};

	return { sendChunk, onAck, abort };
};

const emitChunkedBody = async (reader, ackGate) => {
	let pending = Buffer.alloc(0);

	while (true) {
		const { done, value } = await reader.read();
		if (value?.byteLength) {
			pending = Buffer.concat([pending, Buffer.from(value)]);
		}

		while (pending.length >= HTTP_CHUNK_SIZE || (done && pending.length > 0)) {
			const chunkSize = done ? pending.length : HTTP_CHUNK_SIZE;
			const chunk = Buffer.from(pending.subarray(0, chunkSize));
			pending = pending.subarray(chunkSize);
			if (chunk.length === 0) {
				break;
			}
			await ackGate.sendChunk(chunk);
		}

		if (done) {
			break;
		}
	}
};

const handleHttpRequest = async (socket, { requestId, method = 'GET', path: assetPath } = {}) => {
	if (!requestId) {
		return;
	}

	const target = resolveDistPath(assetPath || '/index.html');
	if (!target) {
		socket.emit('proxy:http:error', { requestId, status: 400, error: 'Invalid path' });
		return;
	}

	const abortController = new AbortController();
	const ackGate = createAckGate(socket, requestId);
	activeHttpRequests.set(requestId, { abortController, ackGate });

	try {
		const response = await fetch(buildLocalAssetUrl(assetPath || '/index.html'), {
			method,
			signal: abortController.signal,
			headers: {
				accept: '*/*',
				'accept-encoding': 'identity'
			}
		});

		if (!socket.connected) {
			return;
		}

		socket.emit('proxy:http:response', {
			requestId,
			status: response.status,
			headers: pickResponseHeaders(response.headers)
		});

		if (!response.body) {
			socket.emit('proxy:http:end', { requestId });
			return;
		}

		await emitChunkedBody(response.body.getReader(), ackGate);
		if (socket.connected) {
			socket.emit('proxy:http:end', { requestId });
		}
	} catch (error) {
		if (abortController.signal.aborted) {
			return;
		}
		socket.emit('proxy:http:error', {
			requestId,
			status: 500,
			error: error.message
		});
	} finally {
		activeHttpRequests.delete(requestId);
	}
};

const abortHttpRequest = ({ requestId } = {}) => {
	const active = activeHttpRequests.get(requestId);
	if (!active) {
		return;
	}
	active.ackGate.abort();
	active.abortController.abort();
	activeHttpRequests.delete(requestId);
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

	fleetSocket.on('proxy:http:request', (payload) => {
		handleHttpRequest(fleetSocket, payload || {});
	});

	fleetSocket.on('proxy:http:chunk:ack', (payload) => {
		activeHttpRequests.get(payload?.requestId)?.ackGate?.onAck(payload);
	});

	fleetSocket.on('proxy:http:abort', abortHttpRequest);

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
		for (const active of activeHttpRequests.values()) {
			active.ackGate.abort();
			active.abortController.abort();
		}
		activeHttpRequests.clear();
		for (const client of sessions.values()) {
			client.disconnect();
		}
		sessions.clear();
	});
};

export {
	attachProxyHandlers
};
