import fs from 'fs/promises';
import * as yaml from 'js-yaml';
import * as authelia from './authelia.js';

/**
 * Who a browser's session belongs to, and what it is allowed to do. Authelia answers the first part;
 * the second comes from the account file it authenticates against, since a session says who someone
 * is and not which groups they are in.
 */

const AUTHELIA_USERS_FILE = '/messier/apps/authelia/config/users.yml';
const ADMIN_GROUP = 'admins';
const ANONYMOUS = { isAuthenticated: false, username: undefined, name: undefined, email: undefined, isAdmin: false, groups: [] };
// One browser holds one session and opens a socket to every module, so the same question arrives many
// times over. Long enough to answer it once for all of them, short enough that a session which ended
// elsewhere stops working here almost immediately.
const CACHE_TTL = 30000;

const cache = new Map();

const cacheKey = ({ cookie, fqdn }) => {
	return `${fqdn}|${cookie}`;
};

const prune = () => {
	const oldest = Date.now() - CACHE_TTL;
	for (const [key, entry] of cache) {
		if (entry.at < oldest) {
			cache.delete(key);
		}
	}
};

const getAccount = async (username) => {
	try {
		const users = yaml.load(await fs.readFile(AUTHELIA_USERS_FILE, { encoding: 'utf8', flag: 'r' }));
		return users?.users?.[username] || {};
	} catch (error) {
		// A node whose apps are not installed yet has no file, and nobody can be signed in without one.
		return {};
	}
};

const resolve = async ({ cookie, fqdn }) => {
	try {
		const session = await authelia.getSession({ cookie, fqdn });
		if (!session) {
			return ANONYMOUS;
		}

		const account = await getAccount(session.username);
		const groups = account.groups || [];
		return {
			isAuthenticated: true,
			username: session.username,
			name: account.displayname,
			email: account.email,
			isAdmin: groups.includes(ADMIN_GROUP),
			groups
		};
	} catch (error) {
		// Authelia is installed onto the pool, so before that it is not there to ask — and a node that
		// cannot check a session has nobody signed in rather than everybody.
		return ANONYMOUS;
	}
};

/** `fqdn` is the name the browser used: it decides which of Authelia's cookie domains applies, so a
 * session reached by any other name is no session at all. */
const getIdentity = async ({ cookie, fqdn }) => {
	if (!cookie) {
		return ANONYMOUS;
	}

	const key = cacheKey({ cookie, fqdn });
	const cached = cache.get(key);
	if (cached && (Date.now() - cached.at) < CACHE_TTL) {
		return cached.identity;
	}

	const identity = await resolve({ cookie, fqdn });
	prune();
	cache.set(key, { identity, at: Date.now() });
	return identity;
};

/** Signing out ends the session at Authelia; this drops what we remembered of it, so nothing keeps
 * working here for as long as the answer would otherwise have been held. */
const forget = ({ cookie, fqdn }) => {
	cache.delete(cacheKey({ cookie, fqdn }));
};

export {
	ANONYMOUS,
	getIdentity,
	forget
};
