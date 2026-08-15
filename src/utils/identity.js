import * as authelia from './authelia.js';

/**
 * Who a request belongs to and where it is calling from, both as Authelia describes them. It is asked
 * the same question the proxy asks for every app it gates, and its answer is taken as given: the
 * account it names, the groups it lists, and whether it would have let the request through with nobody
 * signed in at all — which is what a network let through unasked looks like.
 */

const ADMIN_GROUP = 'admins';
const ANONYMOUS = { isAuthenticated: false, username: undefined, name: undefined, email: undefined, isAdmin: false, groups: [], isLocal: false };
// One browser holds one session and opens a socket to every module, so the same question arrives many
// times over. Long enough to answer it once for all of them, short enough that a session which ended
// elsewhere stops working here almost immediately.
const CACHE_TTL = 30000;

const cache = new Map();

const cacheKey = ({ cookie, fqdn, clientAddress }) => {
	return `${fqdn}|${clientAddress}|${cookie}`;
};

const prune = () => {
	const oldest = Date.now() - CACHE_TTL;
	for (const [key, entry] of cache) {
		if (entry.at < oldest) {
			cache.delete(key);
		}
	}
};

const resolve = async ({ cookie, fqdn, clientAddress }) => {
	try {
		const { isAllowed, identity } = await authelia.authorize({ fqdn, clientAddress, cookie });
		if (!identity) {
			return { ...ANONYMOUS, isLocal: isAllowed };
		}

		return {
			isAuthenticated: true,
			username: identity.username,
			name: identity.name,
			email: identity.email,
			isAdmin: identity.groups.includes(ADMIN_GROUP),
			groups: identity.groups,
			isLocal: isAllowed
		};
	} catch (error) {
		// Authelia is installed onto the pool, so before that it is not there to ask — and a node that
		// cannot check a session has nobody signed in rather than everybody.
		return ANONYMOUS;
	}
};

/** `fqdn` is the name the browser used: it decides which of Authelia's cookie domains applies, so a
 * session reached by any other name is no session at all. */
const getIdentity = async ({ cookie, fqdn, clientAddress }) => {
	const key = cacheKey({ cookie, fqdn, clientAddress });
	const cached = cache.get(key);
	if (cached && (Date.now() - cached.at) < CACHE_TTL) {
		return cached.identity;
	}

	const identity = await resolve({ cookie, fqdn, clientAddress });
	prune();
	cache.set(key, { identity, at: Date.now() });
	return identity;
};

/** Signing out ends the session at Authelia; this drops what we remembered of it, so nothing keeps
 * working here for as long as the answer would otherwise have been held. */
const forget = ({ cookie, fqdn, clientAddress }) => {
	cache.delete(cacheKey({ cookie, fqdn, clientAddress }));
};

export {
	ANONYMOUS,
	getIdentity,
	forget
};
