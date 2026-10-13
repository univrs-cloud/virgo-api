import * as sessions from '../../utils/sessions.js';

const isSameUser = (first, second) => {
	return String(first ?? '').toLowerCase() === String(second ?? '').toLowerCase();
};

const load = async (module) => {
	module.setState('sessions', await sessions.list());
	module.emitState('sessions');
};

const endUserSessions = async (username) => {
	try {
		const userSessions = (await sessions.list()).filter((session) => { return isSameUser(session.username, username); });
		await sessions.end(userSessions.map((session) => { return session.hash; }));
	} catch (error) {
		console.error(`Error ending the sessions of ${username}:`, error);
	}
};

const refresh = async (config, socket, module) => {
	await sessions.reconcile();
	await load(module);
	return { status: 'succeeded' };
};

const revoke = async (config, socket) => {
	const session = (await sessions.list()).find((session) => { return session.id === Number(config?.id); });
	if (!session || (!socket.isAdmin && !isSameUser(session.username, socket.username))) {
		throw new Error('Session not found.');
	}

	if (session.hash === socket.data.sessionHash) {
		throw new Error('This is the session you are using.');
	}

	await sessions.end([session.hash]);
	return { status: 'succeeded' };
};

const revokeAll = async (config, socket) => {
	const username = config?.username;
	if (!username || (!socket.isAdmin && !isSameUser(username, socket.username))) {
		throw new Error('Unauthorized');
	}

	const userSessions = (await sessions.list()).filter((session) => {
		return isSameUser(session.username, username) && session.hash !== socket.data.sessionHash;
	});
	await sessions.end(userSessions.map((session) => { return session.hash; }));
	return { status: 'succeeded', count: userSessions.length };
};

const register = (module) => {
	module.declareState({
		sessions: {
			event: 'user:sessions',
			audience: 'authenticated',
			perSocket: true,
			project: (userSessions, tier, socket) => {
				return module.toArray(userSessions)
					.filter((session) => { return tier === 'admin' || isSameUser(session.username, socket.username); })
					.map(({ hash, ...session }) => { return { ...session, isCurrent: hash === socket.data.sessionHash }; });
			}
		}
	});

	load(module);

	module.eventEmitter
		.on('sessions:updated', () => {
			load(module);
		})
		.on('user:locked', ({ username } = {}) => {
			endUserSessions(username);
		})
		.on('user:deleted', ({ username } = {}) => {
			endUserSessions(username);
		});
};

export default {
	name: 'sessions',
	register,
	commands: {
		'user:sessions:list': { audience: 'authenticated', handler: refresh },
		'user:sessions:revoke': { audience: 'authenticated', handler: revoke },
		'user:sessions:revoke-all': { audience: 'authenticated', handler: revokeAll }
	}
};
