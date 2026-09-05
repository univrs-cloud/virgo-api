import { openInternalSocket } from './fleet_proxy.js';
import { verifyNodeSessionToken, timingSafeEquals } from './node_authz_token.js';
import {
	EVENT_TAG,
	ASSET_TAG,
	ASSET_CHUNK_SIZE,
	MAX_MESSAGE_SIZE,
	encodeEvent,
	decodeEvent,
	encodeContinuation,
	encodeAssetControl,
	encodeAssetChunk,
	decodeAssetFrame
} from './webrtc_frame.js';
import DataChannelSendQueue from './data_channel_send_queue.js';
import { isPrivateAddress } from './private_address.js';
import {
	localFetchDispatcher,
	buildLocalAssetUrl,
	pickResponseHeaders,
	resolveDistPath,
	isCompressible,
	gzipStream
} from './local_assets.js';

const MAX_PENDING_CONTINUATIONS = 8;
const MAX_CONTINUATION_BYTES = 8 * 1024 * 1024;
const CONTINUATION_TIMEOUT_MS = 30_000;
const OFFER_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_ASSET_REQUESTS = 8;
const ASSET_IDLE_TIMEOUT_MS = 30000;
const ASSET_WINDOW_CHUNKS = 8;

const PROTOCOL_VERSION = 1;
const CALL_TIMEOUT_MS = 30_000;
const MAX_PENDING_ICE_CANDIDATES = 128;
const FLEET_OFFLINE_GRACE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15000;
const LIVENESS_TIMEOUT_MS = 45000;

const SESSION_STATE = Object.freeze({
	REQUESTED: 'REQUESTED',
	OPEN_SENT: 'OPEN_SENT',
	OFFER_RECEIVED: 'OFFER_RECEIVED',
	ANSWERED: 'ANSWERED',
	CONNECTED: 'CONNECTED',
	CLOSING: 'CLOSING',
	CLOSED: 'CLOSED'
});
const SESSION_STATE_ORDER = Object.freeze(Object.values(SESSION_STATE).reduce((result, state, index) => {
	result[state] = index;
	return result;
}, {}));

const transitionSession = (session, nextState) => {
	if (!session || SESSION_STATE_ORDER[nextState] < SESSION_STATE_ORDER[session.state]) {
		return false;
	}
	session.state = nextState;
	session.stateChangedAt = Date.now();
	return true;
};

let rtc = null;
try {
	const loaded = await import('node-datachannel');
	rtc = loaded.default ?? loaded;
} catch (error) {
	rtc = null;
}

const sessions = new Map();
let nextContinuationId = 1;
let bindAddress = null;
let fleetOfflineTimer = null;

const setBindAddress = (address) => {
	bindAddress = address || null;
};

const CANDIDATE_PATTERN = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/i;

const isAdvertisableCandidate = (candidate) => {
	const match = CANDIDATE_PATTERN.exec(String(candidate || ''));
	if (!match) {
		return true;
	}

	const [, address, type] = match;
	if (type === 'srflx' || type === 'prflx') {
		return !isPrivateAddress(address);
	}
	return true;
};

const isSupported = () => {
	return Boolean(rtc);
};

const quietly = (action) => {
	try {
		action();
	} catch (error) {
		return;
	}
};

const RELAY_TYPES = {
	udp: 'TurnUdp',
	tcp: 'TurnTcp',
	tls: 'TurnTls'
};

const parseIceUrl = (url) => {
	const match = /^(stun|stuns|turn|turns):(?:\[([^\]]+)\]|([^:?]+))(?::(\d+))?(?:\?(.*))?$/.exec(url);
	if (!match) {
		return null;
	}

	const [, scheme, bracketed, plain, port, query] = match;
	const transport = /transport=(udp|tcp|tls)/.exec(query || '')?.[1];
	return {
		scheme,
		hostname: bracketed || plain,
		port: Number(port) || (scheme === 'turns' || scheme === 'stuns' ? 5349 : 3478),
		transport
	};
};

const toNativeIceServers = (iceServers) => {
	const result = [];
	for (const entry of Array.isArray(iceServers) ? iceServers : []) {
		const source = (typeof entry === 'string') ? { urls: entry } : entry;
		const urls = Array.isArray(source?.urls) ? source.urls : [source?.urls].filter(Boolean);
		for (const url of urls) {
			const parsed = (typeof url === 'string') ? parseIceUrl(url) : null;
			if (!parsed) {
				continue;
			}

			if (parsed.scheme === 'stun' || parsed.scheme === 'stuns') {
				result.push({ hostname: parsed.hostname, port: parsed.port });
				continue;
			}

			if (!source.username || !source.credential) {
				continue;
			}

			const relayType = RELAY_TYPES[parsed.transport ?? (parsed.scheme === 'turns' ? 'tls' : 'udp')];
			// The packaged libdatachannel build uses libjuice. Its binding exposes TCP/TLS relay
			// enums, but those TURN control transports require the optional libnice backend.
			if (relayType !== 'TurnUdp') {
				continue;
			}
			result.push({
				hostname: parsed.hostname,
				port: parsed.port,
				username: source.username,
				password: source.credential,
				relayType
			});
		}
	}

	return result;
};

const startSessionLiveness = (session) => {
	if (session.livenessTimer) {
		return;
	}
	session.lastInboundAt = Date.now();
	session.livenessTimer = setInterval(() => {
		if (Date.now() - session.lastInboundAt >= LIVENESS_TIMEOUT_MS) {
			closeSession(session.id, { notify: true });
		}
	}, HEARTBEAT_INTERVAL_MS);
	session.livenessTimer.unref?.();
};

const sendEvent = (queue, tag, body) => {
	const frame = encodeEvent(tag, body);
	if (frame.length <= MAX_MESSAGE_SIZE) {
		return queue.enqueue(frame);
	}

	const cid = nextContinuationId;
	nextContinuationId = (nextContinuationId + 1) >>> 0 || 1;
	return queue.enqueueMany(encodeContinuation(cid, frame));
};

const createEventsChannel = (session, channel) => {
	const loopbacks = new Map();
	const continuations = new Map();
	const queue = new DataChannelSendQueue(channel, {
		onFailure: () => { closeSession(session.id, { notify: true }); }
	});
	session.channels.add(channel);
	session.sendQueues.add(queue);
	session.loopbackGroups.push(loopbacks);

	const closeLoopback = (namespace) => {
		const entry = loopbacks.get(namespace);
		if (!entry) {
			return;
		}
		loopbacks.delete(namespace);
		entry.client.disconnect();
	};

	const openNamespace = (namespace, { standby = false } = {}) => {
		if (typeof namespace !== 'string' || !namespace.startsWith('/') || loopbacks.has(namespace)) {
			return;
		}

		const client = openInternalSocket({
			namespace,
			remoteUser: session.user?.email || undefined,
			remoteGroups: session.user?.groups || undefined
		});
		if (!client) {
			sendEvent(queue, EVENT_TAG.STATE, { ns: namespace, ok: false, error: 'Local API host is not loopback' });
			return;
		}

		const entry = { client, active: !standby, resnapshotting: false };
		loopbacks.set(namespace, entry);
		client.on('connect', () => {
			sendEvent(queue, EVENT_TAG.STATE, {
				ns: namespace,
				ok: true,
				phase: entry.active ? 'active' : 'prepared'
			});
		});
		client.on('connect_error', (error) => {
			loopbacks.delete(namespace);
			sendEvent(queue, EVENT_TAG.STATE, { ns: namespace, ok: false, error: error?.message || 'Connection failed' });
		});
		client.onAny((event, ...args) => {
			if (entry.active) {
				sendEvent(queue, EVENT_TAG.EVT, { ns: namespace, event, args });
			}
		});
		client.on('disconnect', () => {
			if (entry.resnapshotting && loopbacks.get(namespace) === entry) {
				entry.resnapshotting = false;
				setImmediate(() => {
					if (loopbacks.get(namespace) === entry) {
						client.connect();
					}
				});
				return;
			}
			loopbacks.delete(namespace);
			sendEvent(queue, EVENT_TAG.STATE, { ns: namespace, ok: false });
		});
	};

	const activateNamespace = (namespace) => {
		const entry = loopbacks.get(namespace);
		if (!entry?.client.connected) {
			sendEvent(queue, EVENT_TAG.STATE, { ns: namespace, ok: false, error: 'Namespace is not prepared' });
			return;
		}
		if (entry.active) {
			sendEvent(queue, EVENT_TAG.STATE, { ns: namespace, ok: true, phase: 'active' });
			return;
		}
		entry.active = true;
		entry.resnapshotting = true;
		entry.client.disconnect();
	};

	const handleCall = async ({ ns, cid, event, args, timeout }) => {
		const entry = loopbacks.get(ns);
		if (!entry?.active || !entry.client.connected) {
			sendEvent(queue, EVENT_TAG.REPLY, { ns, cid, error: { message: 'Namespace is not active' } });
			return;
		}

		try {
			const bounded = Number.isFinite(timeout) ? Math.min(timeout, CALL_TIMEOUT_MS) : CALL_TIMEOUT_MS;
			const result = await entry.client.timeout(bounded).emitWithAck(event, ...(Array.isArray(args) ? args : []));
			sendEvent(queue, EVENT_TAG.REPLY, { ns, cid, result });
		} catch (error) {
			sendEvent(queue, EVENT_TAG.REPLY, { ns, cid, error: { message: error?.message || 'operation has timed out' } });
		}
	};

	const dispatch = (frame) => {
		switch (frame.tag) {
			case EVENT_TAG.HELLO:
				sendEvent(queue, EVENT_TAG.HELLO, {
					v: PROTOCOL_VERSION,
					ok: frame.body?.v === PROTOCOL_VERSION
				});
				if (frame.body?.v === PROTOCOL_VERSION && session.state !== SESSION_STATE.CONNECTED) {
					transitionSession(session, SESSION_STATE.CONNECTED);
					clearTimeout(session.offerTimer);
					session.offerTimer = null;
				}
				startSessionLiveness(session);
				return;
			case EVENT_TAG.PING:
				sendEvent(queue, EVENT_TAG.PONG, {});
				return;
			case EVENT_TAG.OPEN:
				openNamespace(frame.body?.ns, { standby: Boolean(frame.body?.standby) });
				return;
			case EVENT_TAG.ACTIVATE:
				activateNamespace(frame.body?.ns);
				return;
			case EVENT_TAG.EVT: {
				const entry = loopbacks.get(frame.body?.ns);
				if (entry?.active && entry.client.connected) {
					entry.client.emit(frame.body.event, ...(Array.isArray(frame.body.args) ? frame.body.args : []));
				}
				return;
			}
			case EVENT_TAG.CALL:
				handleCall(frame.body ?? {}).catch(() => {});
				return;
			case EVENT_TAG.CLOSE:
				closeLoopback(frame.body?.ns);
				return;
			default:
		}
	};

	const reassemble = (frame) => {
		let pending = continuations.get(frame.cid);
		if (!pending) {
			if (continuations.size >= MAX_PENDING_CONTINUATIONS) {
				return;
			}
			pending = {
				parts: new Array(frame.total).fill(null),
				received: 0,
				bytes: 0,
				timer: setTimeout(() => { continuations.delete(frame.cid); }, CONTINUATION_TIMEOUT_MS)
			};
			pending.timer.unref?.();
			continuations.set(frame.cid, pending);
		}
		if (pending.parts.length !== frame.total) {
			clearTimeout(pending.timer);
			continuations.delete(frame.cid);
			return;
		}
		if (!pending.parts[frame.part]) {
			if (pending.bytes + frame.slice.length > MAX_CONTINUATION_BYTES) {
				clearTimeout(pending.timer);
				continuations.delete(frame.cid);
				return;
			}
			pending.parts[frame.part] = Buffer.from(frame.slice);
			pending.received += 1;
			pending.bytes += frame.slice.length;
		}
		if (pending.received < frame.total) {
			return;
		}

		clearTimeout(pending.timer);
		continuations.delete(frame.cid);
		const complete = decodeEvent(Buffer.concat(pending.parts));
		if (complete && complete.tag !== EVENT_TAG.CONT) {
			dispatch(complete);
		}
	};

	channel.onMessage((message) => {
		try {
			session.lastInboundAt = Date.now();
			const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
			const frame = decodeEvent(buffer);
			if (!frame) {
				return;
			}
			if (frame.tag === EVENT_TAG.CONT) {
				reassemble(frame);
				return;
			}

			dispatch(frame);
		} catch (error) {
			console.error('Error handling a WebRTC events frame:', error);
		}
	});

	channel.onClosed(() => {
		session.channels.delete(channel);
		session.sendQueues.delete(queue);
		queue.close();
		for (const continuation of continuations.values()) {
			clearTimeout(continuation.timer);
		}
		continuations.clear();
		for (const entry of loopbacks.values()) {
			entry.client.disconnect();
		}
		loopbacks.clear();
	});
	channel.onError(() => { closeSession(session.id, { notify: true }); });
};

const createAssetsChannel = (session, channel) => {
	const requests = new Map();
	const queue = new DataChannelSendQueue(channel, {
		onFailure: () => { failChannel(); }
	});
	session.channels.add(channel);
	session.sendQueues.add(queue);

	const send = (tag, requestId, body) => {
		return queue.enqueue(encodeAssetControl(tag, requestId, body));
	};

	const abortAll = () => {
		for (const request of requests.values()) {
			clearTimeout(request.timer);
			quietly(() => { request.controller.abort(); });
		}
		requests.clear();
	};

	const failChannel = () => {
		abortAll();
		quietly(() => { channel.close(); });
	};

	const touchRequest = (requestId, request) => {
		clearTimeout(request.timer);
		if (request.controller.signal.aborted || requests.get(requestId) !== request) {
			return;
		}
		request.timer = setTimeout(() => {
			send(ASSET_TAG.ERR, requestId, { status: 504, message: 'Asset transfer stalled' });
			request.controller.abort();
			requests.delete(requestId);
		}, ASSET_IDLE_TIMEOUT_MS);
		request.timer.unref?.();
	};

	const takeCredit = async (requestId, request) => {
		if (request.controller.signal.aborted || requests.get(requestId) !== request) {
			throw new Error('Asset request aborted');
		}
		if (!request.flowControl) {
			return;
		}
		if (!request.credits) {
			await new Promise((resolve, reject) => {
				const signal = request.controller.signal;
				const finish = (error) => {
					signal.removeEventListener('abort', aborted);
					request.resume = null;
					error ? reject(error) : resolve();
				};
				const aborted = () => { finish(new Error('Asset request aborted')); };
				request.resume = () => { finish(); };
				signal.addEventListener('abort', aborted, { once: true });
				if (signal.aborted) { aborted(); }
			});
		}
		if (request.controller.signal.aborted || !requests.has(requestId)) {
			throw new Error('Asset request aborted');
		}
		request.credits -= 1;
	};

	const pump = async (requestId, reader, controller) => {
		const request = requests.get(requestId);
		let seq = 0;
		let pending = Buffer.alloc(0);
		const flush = async (final) => {
			while (pending.length >= ASSET_CHUNK_SIZE || (final && pending.length)) {
				await takeCredit(requestId, request);
				const size = Math.min(pending.length, ASSET_CHUNK_SIZE);
				const slice = Buffer.from(pending.subarray(0, size));
				pending = pending.subarray(size);
				if (!queue.enqueue(encodeAssetChunk(requestId, seq, slice))) {
					throw new Error('Asset channel is not writable');
				}
				seq += 1;
				await queue.whenDrained(controller.signal);
				touchRequest(requestId, request);
				if (controller.signal.aborted || !requests.has(requestId)) {
					throw new Error('Asset request aborted');
				}
			}
		};

		while (true) {
			const { done, value } = await reader.read();
			touchRequest(requestId, request);
			if (value?.byteLength) {
				const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
			}
			await flush(done);
			if (done) {
				return;
			}
		}
	};

	const handleRequest = async (requestId, body) => {
		if (requests.has(requestId)) {
			return;
		}
		if (requests.size >= MAX_CONCURRENT_ASSET_REQUESTS) {
			send(ASSET_TAG.ERR, requestId, { status: 429, message: 'Too many asset requests' });
			return;
		}

		const assetPath = (typeof body?.path === 'string') ? body.path : '';
		if (!assetPath.startsWith('/') || !resolveDistPath(assetPath)) {
			send(ASSET_TAG.ERR, requestId, { status: 400, message: 'Invalid path' });
			return;
		}
		const url = buildLocalAssetUrl(assetPath);
		if (!url) {
			send(ASSET_TAG.ERR, requestId, { status: 500, message: 'Local API host is not loopback' });
			return;
		}

		const controller = new AbortController();
		const request = { controller, credits: 0, flowControl: body.flowControl === true, resume: null, timer: null };
		requests.set(requestId, request);
		touchRequest(requestId, request);
		try {
			const response = await fetch(url, {
				method: 'GET',
				signal: controller.signal,
				dispatcher: localFetchDispatcher,
				headers: {
					accept: '*/*',
					'accept-encoding': 'identity'
				}
			});
			if (!requests.has(requestId)) {
				return;
			}
			touchRequest(requestId, request);
			const headers = pickResponseHeaders(response.headers);
			const gzip = body.acceptEncoding === 'gzip'
				&& isCompressible(headers['content-type'], Number(response.headers.get('content-length')));
			if (gzip) {
				headers['content-encoding'] = 'gzip';
			}
			send(ASSET_TAG.RES, requestId, {
				status: response.status,
				headers
			});
			if (response.body) {
				const stream = gzip ? gzipStream(response.body) : response.body;
				await pump(requestId, stream.getReader(), controller);
			}
			if (requests.has(requestId)) {
				send(ASSET_TAG.END, requestId, {});
			}
		} catch (error) {
			if (!controller.signal.aborted && requests.has(requestId)) {
				send(ASSET_TAG.ERR, requestId, { status: 502, message: error.message });
			}
		} finally {
			clearTimeout(request.timer);
			if (requests.get(requestId) === request) {
				requests.delete(requestId);
			}
			controller.abort();
		}
	};

	const handleAbort = (requestId) => {
		const request = requests.get(requestId);
		if (!request) {
			return;
		}
		requests.delete(requestId);
		clearTimeout(request.timer);
		quietly(() => { request.controller.abort(); });
	};

	channel.onMessage((message) => {
		try {
			session.lastInboundAt = Date.now();
			const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
			const frame = decodeAssetFrame(buffer);
			if (!frame) {
				return;
			}
			if (frame.tag === ASSET_TAG.REQ) {
				handleRequest(frame.requestId, frame.body).catch(() => {});
				return;
			}
			if (frame.tag === ASSET_TAG.ABORT) {
				handleAbort(frame.requestId);
			}
			if (frame.tag === ASSET_TAG.CREDIT) {
				const request = requests.get(frame.requestId);
				const chunks = frame.body?.chunks;
				if (request?.flowControl && Number.isInteger(chunks) && chunks > 0 && request.credits + chunks <= ASSET_WINDOW_CHUNKS) {
					request.credits += chunks;
					touchRequest(frame.requestId, request);
					request.resume?.();
				}
			}
		} catch (error) {
			console.error('Error handling a WebRTC asset frame:', error);
		}
	});

	channel.onClosed(() => {
		session.channels.delete(channel);
		session.sendQueues.delete(queue);
		queue.close();
		abortAll();
	});
	channel.onError(() => { failChannel(); });
};

const closeSession = (sessionId, { notify = false } = {}) => {
	const session = sessions.get(sessionId);
	if (!session) {
		return;
	}

	sessions.delete(sessionId);
	transitionSession(session, SESSION_STATE.CLOSING);
	clearTimeout(session.offerTimer);
	clearInterval(session.livenessTimer);
	session.livenessTimer = null;
	for (const loopbacks of session.loopbackGroups) {
		for (const entry of loopbacks.values()) {
			entry.client.disconnect();
		}
		loopbacks.clear();
	}
	for (const queue of session.sendQueues) {
		queue.close();
	}
	session.sendQueues.clear();
	for (const channel of session.channels) {
		quietly(() => { channel.close(); });
	}
	session.channels.clear();
	quietly(() => { session.pc.close(); });
	transitionSession(session, SESSION_STATE.CLOSED);

	if (notify && session.fleetSocket?.connected) {
		session.fleetSocket.emit('webrtc:close', { sessionId });
	}
};

const openSession = (fleetSocket, { sessionId, token, iceServers }, { nodeToken, nodeId }) => {
	if (!sessionId || sessions.has(sessionId)) {
		return;
	}
	if (!rtc) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'WebRTC is not available on this node' });
		return;
	}

	const claims = verifyNodeSessionToken(token, { nodeToken, nodeId, sessionId });
	if (!claims) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Invalid session token' });
		return;
	}

	let pc = null;
	try {
		const configuration = { iceServers: toNativeIceServers(iceServers) };
		if (bindAddress) {
			configuration.bindAddress = bindAddress;
		}
		pc = new rtc.PeerConnection(`fleet-${sessionId}`, configuration);
	} catch (error) {
		fleetSocket.emit('webrtc:error', { sessionId, message: error.message });
		return;
	}

	const session = {
		id: sessionId,
		pc,
		token,
		user: {
			email: (typeof claims.email === 'string' && claims.email) || null,
			groups: Array.isArray(claims.groups) ? claims.groups : null
		},
		fleetSocket,
		channels: new Set(),
		sendQueues: new Set(),
		loopbackGroups: [],
		pendingCandidates: [],
		offerTimer: null,
		livenessTimer: null,
		lastInboundAt: 0,
		state: SESSION_STATE.REQUESTED,
		stateChangedAt: Date.now()
	};
	sessions.set(sessionId, session);
	session.offerTimer = setTimeout(() => {
		closeSession(sessionId, { notify: true });
	}, OFFER_TIMEOUT_MS);
	session.offerTimer.unref?.();

	pc.onLocalDescription((sdp, type) => {
		if (type === 'answer' && fleetSocket.connected) {
			transitionSession(session, SESSION_STATE.ANSWERED);
			fleetSocket.emit('webrtc:answer', { sessionId, sdp });
		}
	});

	pc.onLocalCandidate((candidate, mid) => {
		if (fleetSocket.connected && isAdvertisableCandidate(candidate)) {
			fleetSocket.emit('webrtc:candidate', { sessionId, candidate: { candidate, sdpMid: mid } });
		}
	});

	pc.onDataChannel((channel) => {
		const label = String(channel.getLabel() || '');
		if (label === 'events') {
			createEventsChannel(session, channel);
			return;
		}
		if (label === 'assets') {
			createAssetsChannel(session, channel);
			return;
		}
		quietly(() => { channel.close(); });
	});

	pc.onStateChange((state) => {
		if (state === 'connected') {
			transitionSession(session, SESSION_STATE.CONNECTED);
			clearTimeout(session.offerTimer);
			session.offerTimer = null;
			if (fleetSocket.connected) {
				fleetSocket.emit('webrtc:connected', { sessionId });
			}
			return;
		}
		if (state === 'failed' || state === 'closed') {
			closeSession(sessionId, { notify: state === 'failed' });
		}
	});
	transitionSession(session, SESSION_STATE.OPEN_SENT);
};

const applyOffer = (fleetSocket, { sessionId, sdp, token }) => {
	const session = sessions.get(sessionId);
	if (!session) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Unknown session' });
		return;
	}
	if (session.state !== SESSION_STATE.OPEN_SENT) {
		fleetSocket.emit('webrtc:error', { sessionId, message: `Offer not expected in state ${session.state}` });
		closeSession(sessionId);
		return;
	}
	if (typeof sdp !== 'string' || !sdp) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Offer is missing its SDP' });
		closeSession(sessionId);
		return;
	}

	if (!timingSafeEquals(token, session.token)) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Session token mismatch' });
		closeSession(sessionId);
		return;
	}

	try {
		transitionSession(session, SESSION_STATE.OFFER_RECEIVED);
		session.pc.setRemoteDescription(sdp, 'offer');
		for (const pendingCandidate of session.pendingCandidates) {
			quietly(() => {
				session.pc.addRemoteCandidate(pendingCandidate.candidate, pendingCandidate.sdpMid ?? '0');
			});
		}
		session.pendingCandidates = [];
	} catch (error) {
		fleetSocket.emit('webrtc:error', { sessionId, message: error.message });
		closeSession(sessionId);
	}
};

const addCandidate = ({ sessionId, candidate }) => {
	const session = sessions.get(sessionId);
	if (!session || !candidate?.candidate) {
		return;
	}

	if (session.state === SESSION_STATE.OPEN_SENT) {
		if (session.pendingCandidates.length < MAX_PENDING_ICE_CANDIDATES) {
			session.pendingCandidates.push(candidate);
		}
		return;
	}
	quietly(() => { session.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? '0'); });
};

const closeAllSessions = () => {
	clearTimeout(fleetOfflineTimer);
	fleetOfflineTimer = null;
	for (const sessionId of [...sessions.keys()]) {
		closeSession(sessionId);
	}
};

const attachWebrtcHandlers = (fleetSocket, { token, nodeId } = {}) => {
	if (!rtc || !fleetSocket || fleetSocket.data?.webrtcAttached) {
		return;
	}
	fleetSocket.data = fleetSocket.data || {};
	fleetSocket.data.webrtcAttached = true;

	fleetSocket.on('webrtc:open', (payload = {}) => {
		openSession(fleetSocket, payload, { nodeToken: token, nodeId });
	});
	fleetSocket.on('webrtc:offer', (payload = {}) => {
		applyOffer(fleetSocket, payload);
	});
	fleetSocket.on('webrtc:candidate', (payload = {}) => {
		addCandidate(payload);
	});
	fleetSocket.on('webrtc:close', ({ sessionId } = {}) => {
		closeSession(sessionId);
	});
	fleetSocket.on('disconnect', () => {
		clearTimeout(fleetOfflineTimer);
		fleetOfflineTimer = setTimeout(() => {
			fleetOfflineTimer = null;
			closeAllSessions();
		}, FLEET_OFFLINE_GRACE_MS);
		fleetOfflineTimer.unref?.();
	});
	fleetSocket.on('connect', () => { announceSessions(fleetSocket); });
	announceSessions(fleetSocket);
};

const announceSessions = (fleetSocket) => {
	clearTimeout(fleetOfflineTimer);
	fleetOfflineTimer = null;
	if (!fleetSocket.connected) {
		return;
	}
	const sessionIds = [...sessions.values()]
		.filter((session) => { return session.state === SESSION_STATE.CONNECTED; })
		.map((session) => { return session.id; });
	fleetSocket.emit('webrtc:sessions', { sessionIds });
};

const shutdown = () => {
	closeAllSessions();
	quietly(() => { rtc?.cleanup(); });
};

export {
	attachWebrtcHandlers,
	closeAllSessions,
	isSupported,
	setBindAddress,
	shutdown,
	toNativeIceServers
};
