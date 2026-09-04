import { openInternalSocket } from './fleet_proxy.js';
import { verifyNodeSessionToken, timingSafeEquals } from './node_authz_token.js';
import {
	EVENT_TAG,
	MAX_MESSAGE_SIZE,
	encodeEvent,
	decodeEvent,
	encodeContinuation
} from './webrtc_frame.js';

const PROTOCOL_VERSION = 1;
const CALL_TIMEOUT_MS = 30_000;

let rtc = null;
try {
	const loaded = await import('node-datachannel');
	rtc = loaded.default ?? loaded;
} catch (error) {
	rtc = null;
}

const sessions = new Map();
let nextContinuationId = 1;

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

const isOpen = (channel) => {
	try {
		return Boolean(channel?.isOpen());
	} catch (error) {
		return false;
	}
};

const send = (channel, buffer) => {
	if (!isOpen(channel)) {
		return false;
	}

	try {
		channel.sendMessageBinary(buffer);
		return true;
	} catch (error) {
		return false;
	}
};

const sendEvent = (channel, tag, body) => {
	const frame = encodeEvent(tag, body);
	if (frame.length <= MAX_MESSAGE_SIZE) {
		return send(channel, frame);
	}

	const cid = nextContinuationId;
	nextContinuationId = (nextContinuationId + 1) >>> 0 || 1;
	for (const slice of encodeContinuation(cid, frame)) {
		if (!send(channel, slice)) {
			return false;
		}
	}

	return true;
};

const createEventsChannel = (session, channel) => {
	const loopbacks = new Map();
	const continuations = new Map();
	session.channels.add(channel);
	session.loopbackGroups.push(loopbacks);

	const closeLoopback = (namespace) => {
		const client = loopbacks.get(namespace);
		if (!client) {
			return;
		}
		loopbacks.delete(namespace);
		client.disconnect();
	};

	const openNamespace = (namespace) => {
		if (typeof namespace !== 'string' || !namespace.startsWith('/') || loopbacks.has(namespace)) {
			return;
		}

		const client = openInternalSocket({ namespace });
		if (!client) {
			sendEvent(channel, EVENT_TAG.STATE, { ns: namespace, ok: false, error: 'Local API host is not loopback' });
			return;
		}

		loopbacks.set(namespace, client);
		client.on('connect', () => {
			sendEvent(channel, EVENT_TAG.STATE, { ns: namespace, ok: true });
		});
		client.on('connect_error', (error) => {
			loopbacks.delete(namespace);
			sendEvent(channel, EVENT_TAG.STATE, { ns: namespace, ok: false, error: error?.message || 'Connection failed' });
		});
		client.onAny((event, ...args) => {
			sendEvent(channel, EVENT_TAG.EVT, { ns: namespace, event, args });
		});
		client.on('disconnect', () => {
			loopbacks.delete(namespace);
			sendEvent(channel, EVENT_TAG.STATE, { ns: namespace, ok: false });
		});
	};

	const handleCall = async ({ ns, cid, event, args, timeout }) => {
		const client = loopbacks.get(ns);
		if (!client?.connected) {
			sendEvent(channel, EVENT_TAG.REPLY, { ns, cid, error: { message: 'Namespace is not open' } });
			return;
		}

		try {
			const bounded = Number.isFinite(timeout) ? Math.min(timeout, CALL_TIMEOUT_MS) : CALL_TIMEOUT_MS;
			const result = await client.timeout(bounded).emitWithAck(event, ...(Array.isArray(args) ? args : []));
			sendEvent(channel, EVENT_TAG.REPLY, { ns, cid, result });
		} catch (error) {
			sendEvent(channel, EVENT_TAG.REPLY, { ns, cid, error: { message: error?.message || 'operation has timed out' } });
		}
	};

	const dispatch = (frame) => {
		switch (frame.tag) {
			case EVENT_TAG.HELLO:
				sendEvent(channel, EVENT_TAG.HELLO, { v: PROTOCOL_VERSION });
				return;
			case EVENT_TAG.OPEN:
				openNamespace(frame.body?.ns);
				return;
			case EVENT_TAG.EVT: {
				const client = loopbacks.get(frame.body?.ns);
				if (client?.connected) {
					client.emit(frame.body.event, ...(Array.isArray(frame.body.args) ? frame.body.args : []));
				}
				return;
			}
			case EVENT_TAG.CALL:
				handleCall(frame.body ?? {}).catch(() => {});
				return;
			case EVENT_TAG.STATE:
				closeLoopback(frame.body?.ns);
				return;
			default:
		}
	};

	const reassemble = (frame) => {
		const pending = continuations.get(frame.cid) ?? { parts: new Array(frame.total).fill(null), received: 0 };
		if (!pending.parts[frame.part]) {
			pending.parts[frame.part] = Buffer.from(frame.slice);
			pending.received += 1;
		}
		continuations.set(frame.cid, pending);
		if (pending.received < frame.total) {
			return;
		}

		continuations.delete(frame.cid);
		const complete = decodeEvent(Buffer.concat(pending.parts));
		if (complete && complete.tag !== EVENT_TAG.CONT) {
			dispatch(complete);
		}
	};

	channel.onMessage((message) => {
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
	});

	channel.onClosed(() => {
		session.channels.delete(channel);
		continuations.clear();
		for (const client of loopbacks.values()) {
			client.disconnect();
		}
		loopbacks.clear();
	});
};

const closeSession = (sessionId, { notify = false } = {}) => {
	const session = sessions.get(sessionId);
	if (!session) {
		return;
	}

	sessions.delete(sessionId);
	for (const loopbacks of session.loopbackGroups) {
		for (const client of loopbacks.values()) {
			client.disconnect();
		}
		loopbacks.clear();
	}
	for (const channel of session.channels) {
		quietly(() => { channel.close(); });
	}
	session.channels.clear();
	quietly(() => { session.pc.close(); });

	if (notify && session.fleetSocket?.connected) {
		session.fleetSocket.emit('webrtc:close', { sessionId });
	}
};

const openSession = (fleetSocket, { sessionId, token, iceServers }, { nodeToken, nodeId }) => {
	if (!rtc || !sessionId || sessions.has(sessionId)) {
		return;
	}

	if (!verifyNodeSessionToken(token, { nodeToken, nodeId, sessionId })) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Invalid session token' });
		return;
	}

	let pc = null;
	try {
		pc = new rtc.PeerConnection(`fleet-${sessionId}`, { iceServers: toNativeIceServers(iceServers) });
	} catch (error) {
		fleetSocket.emit('webrtc:error', { sessionId, message: error.message });
		return;
	}

	const session = {
		pc,
		token,
		fleetSocket,
		channels: new Set(),
		loopbackGroups: []
	};
	sessions.set(sessionId, session);

	pc.onLocalDescription((sdp, type) => {
		if (type === 'answer' && fleetSocket.connected) {
			fleetSocket.emit('webrtc:answer', { sessionId, sdp });
		}
	});

	pc.onLocalCandidate((candidate, mid) => {
		if (fleetSocket.connected) {
			fleetSocket.emit('webrtc:candidate', { sessionId, candidate: { candidate, sdpMid: mid } });
		}
	});

	pc.onDataChannel((channel) => {
		const label = String(channel.getLabel() || '');
		if (label === 'events') {
			createEventsChannel(session, channel);
			return;
		}
		quietly(() => { channel.close(); });
	});

	pc.onStateChange((state) => {
		if (state === 'failed' || state === 'closed') {
			closeSession(sessionId, { notify: state === 'failed' });
		}
	});
};

const applyOffer = (fleetSocket, { sessionId, sdp, token }) => {
	const session = sessions.get(sessionId);
	if (!session || !sdp) {
		return;
	}

	if (!timingSafeEquals(token, session.token)) {
		fleetSocket.emit('webrtc:error', { sessionId, message: 'Session token mismatch' });
		closeSession(sessionId);
		return;
	}

	try {
		session.pc.setRemoteDescription(sdp, 'offer');
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

	quietly(() => { session.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? '0'); });
};

const closeAllSessions = () => {
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
	fleetSocket.on('disconnect', closeAllSessions);
};

const shutdown = () => {
	closeAllSessions();
	quietly(() => { rtc?.cleanup(); });
};

export {
	attachWebrtcHandlers,
	closeAllSessions,
	isSupported,
	shutdown,
	toNativeIceServers
};
