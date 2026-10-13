import { createHash } from 'crypto';
import { execa } from 'execa';
import DataService from '../database/data_service.js';
import docker from './docker_client.js';
import eventEmitter from './event_emitter.js';

const KEY_PREFIX = 'authelia-session:';
const REDIS_LABELS = ['com.docker.compose.project=authelia', 'com.docker.compose.service=redis'];
const MAX_USER_AGENT_LENGTH = 512;
const SESSION_ACTIVITY_THROTTLE_MS = 60 * 1000;
const SESSION_TOUCH_CACHE_LIMIT = 5000;
const socketsByHash = new Map();
const sessionTouches = new Map();

const pruneSessionTouches = () => {
	if (sessionTouches.size <= SESSION_TOUCH_CACHE_LIMIT) {
		return;
	}

	const cutoff = Date.now() - SESSION_ACTIVITY_THROTTLE_MS;
	for (const [hash, touch] of sessionTouches) {
		if (touch.at < cutoff) {
			sessionTouches.delete(hash);
		}
	}
};

const hashOf = (sessionId) => {
	return (sessionId ? createHash('sha256').update(sessionId).digest('hex') : undefined);
};

const agentOf = (userAgent) => {
	return String(userAgent ?? '').trim().slice(0, MAX_USER_AGENT_LENGTH) || null;
};

const redis = async (args) => {
	const [container] = await docker.listContainers({ filters: { label: REDIS_LABELS } });
	if (!container) {
		throw new Error('Authelia is not running.');
	}

	const { stdout } = await execa('docker', ['exec', container.Id, 'redis-cli', '--raw', ...args]);
	return stdout;
};

const keysByHash = async () => {
	const keys = (await redis(['--scan', '--pattern', `${KEY_PREFIX}*`])).split('\n').map((key) => { return key.trim(); }).filter(Boolean);
	return new Map(keys.map((key) => { return [hashOf(key.slice(KEY_PREFIX.length)), key]; }));
};

const forget = async (hashes) => {
	if (hashes.length === 0) {
		return;
	}

	await DataService.deleteSessions(hashes);
	for (const hash of hashes) {
		sessionTouches.delete(hash);
		for (const socket of socketsByHash.get(hash) ?? []) {
			socket.data.renewIdentity?.();
		}
	}
	eventEmitter.emit('sessions:updated');
};

const create = async ({ sessionId, username, ipAddress, userAgent }) => {
	const hash = hashOf(sessionId);
	if (!hash) {
		return;
	}

	await DataService.setSession({ hash, username, ipAddress: ipAddress || null, userAgent: agentOf(userAgent), lastSeenAt: new Date() });
	eventEmitter.emit('sessions:updated');
};

const touch = async ({ sessionId, ipAddress, userAgent }) => {
	const hash = hashOf(sessionId);
	if (!hash) {
		return;
	}

	const now = Date.now();
	const previous = sessionTouches.get(hash);
	const hasMoved = Boolean(ipAddress) && previous?.ipAddress !== ipAddress;
	// Record activity at most once a minute, while IP changes are reflected immediately.
	if (!hasMoved && now - (previous?.at ?? 0) < SESSION_ACTIVITY_THROTTLE_MS) {
		return;
	}

	sessionTouches.set(hash, { at: now, ipAddress: ipAddress ?? previous?.ipAddress });
	pruneSessionTouches();
	const values = { lastSeenAt: new Date(now) };
	if (ipAddress) {
		values.ipAddress = ipAddress;
	}
	if (agentOf(userAgent)) {
		values.userAgent = agentOf(userAgent);
	}
	const updated = await DataService.updateSession(hash, values);
	if (updated && hasMoved) {
		eventEmitter.emit('sessions:updated');
	}
};

const remove = async ({ sessionId }) => {
	const hash = hashOf(sessionId);
	if (hash) {
		await forget([hash]);
	}
};

const track = (socket) => {
	const hash = socket.data.sessionHash;
	if (!hash) {
		return;
	}

	const sockets = socketsByHash.get(hash) ?? new Set();
	sockets.add(socket);
	socketsByHash.set(hash, sockets);
	if (sockets.size === 1) {
		eventEmitter.emit('sessions:updated');
	}

	socket.on('disconnect', async () => {
		sockets.delete(socket);
		if (sockets.size > 0) {
			return;
		}

		if (socketsByHash.get(hash) === sockets) {
			socketsByHash.delete(hash);
		}
		await DataService.updateSession(hash, { lastSeenAt: new Date() });
		eventEmitter.emit('sessions:updated');
	});
};

const list = async () => {
	const sessions = await DataService.getSessions();
	return sessions
		.map((session) => { return { ...session, isConnected: socketsByHash.has(session.hash) }; })
		.sort((first, second) => { return Number(second.isConnected) - Number(first.isConnected); });
};

const reconcile = async () => {
	const sessions = await DataService.getSessions();
	if (sessions.length === 0) {
		return;
	}

	let keys;
	try {
		keys = await keysByHash();
	} catch (error) {
		return;
	}

	await forget(sessions.filter((session) => { return !keys.has(session.hash); }).map((session) => { return session.hash; }));
};

const end = async (hashes) => {
	if (hashes.length === 0) {
		return;
	}

	const keys = await keysByHash();
	const doomed = hashes.map((hash) => { return keys.get(hash); }).filter(Boolean);
	if (doomed.length > 0) {
		await redis(['DEL', ...doomed]);
	}
	await forget(hashes);
};

export {
	hashOf,
	create,
	touch,
	remove,
	track,
	list,
	reconcile,
	end
};
