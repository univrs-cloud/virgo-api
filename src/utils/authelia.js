import config from '../../config.js';
import * as traefikConfig from './traefik_config.js';

/**
 * Authelia owns every session on this node: it issues them, validates them and expires them. This
 * talks to its API so the login screen can live in our own UI instead of its portal, and it never
 * mints anything of its own — the cookies it hands back are Authelia's, passed to the browser as they
 * arrived, so a session established here is the same one the portal would have created and every app
 * traefik gates accepts it.
 */

/** Authelia answers on the node's own loopback: virgo-api runs on the host, not on the docker network
 * the container is attached to, and the traffic never leaves the machine. */
const BASE_URL = config.authelia.url;
// The one thing this node concludes for itself from what Authelia reports: which of its groups runs it.
const ADMIN_GROUP = 'admins';
const READINESS_PROBE_TIMEOUT = 2000;
const READINESS_CACHE = 1000;

let cookieDomain;
let cookieName;
let readiness = { ready: false, at: 0 };
let readinessProbe = null;

/** Authelia reads the request's target from these, and the client's address from X-Forwarded-For,
 * falling back to whoever opened the connection. Both matter: the target decides which session cookie
 * domain applies, and the address is what its rate limiting counts and what its network rules match —
 * left out, every login on the node looks like it came from virgo-api itself. */
const buildForwardedHeaders = (fqdn, clientAddress) => {
	return {
		'x-forwarded-proto': 'https',
		'x-forwarded-host': fqdn,
		'x-forwarded-uri': '/',
		...(clientAddress ? { 'x-forwarded-for': clientAddress } : {})
	};
};

const request = async (path, { fqdn, clientAddress, cookie, body } = {}) => {
	return fetch(`${BASE_URL}${path}`, {
		method: (body ? 'POST' : 'GET'),
		headers: {
			...buildForwardedHeaders(fqdn, clientAddress),
			...(cookie ? { cookie } : {}),
			...(body ? { 'content-type': 'application/json' } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
};

/** The cookies Authelia set on this response, to be relayed to the browser untouched: their name,
 * domain, flags and lifetime are Authelia's configuration, and copying any of it here would be a
 * second answer to the same question. Every one of them states the domain it is for, which is the only
 * place that domain is written down by whoever decides it, so it is noted on the way past. */
const readSessionCookies = (response) => {
	const cookies = response.headers.getSetCookie();
	const domain = cookies.map((cookie) => { return cookie.match(/;\s*Domain=([^;]+)/i)?.[1]; }).find(Boolean);
	if (domain) {
		cookieDomain = domain.trim().replace(/^\./, '');
		cookieName = cookies.find((cookie) => { return /;\s*Domain=/i.test(cookie); }).split('=')[0].trim();
	}

	return cookies;
};

const getCookieName = () => {
	if (!cookieName) {
		const domain = traefikConfig.getDomain();
		cookieName = (domain ? `virgoOS_${domain.split('.')[0]}` : undefined);
	}

	return cookieName;
};

const findSessionId = (pairs) => {
	if (!getCookieName()) {
		return undefined;
	}

	const prefix = `${cookieName}=`;
	const pair = pairs.map((entry) => { return entry.trim(); }).find((entry) => { return entry.startsWith(prefix); });
	return (pair ? pair.slice(prefix.length) : undefined) || undefined;
};

/** Whoever the session belongs to, as Authelia describes them: it authenticates before it weighs any
 * rule, so a request it lets through unasked still names the person holding it. */
const parseIdentity = (response) => {
	const username = response.headers.get('remote-user');
	if (!username) {
		return undefined;
	}

	const groups = (response.headers.get('remote-groups') || '').split(',').filter(Boolean);
	return {
		username,
		name: response.headers.get('remote-name') || undefined,
		email: response.headers.get('remote-email') || undefined,
		isAdmin: groups.includes(ADMIN_GROUP),
		groups
	};
};

const isReady = async () => {
	if ((Date.now() - readiness.at) < READINESS_CACHE) {
		return readiness.ready;
	}

	if (!readinessProbe) {
		readinessProbe = (async () => {
			let ready = false;
			try {
				const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT) });
				ready = response.ok;
			} catch (error) {
				ready = false;
			}
			readiness = { ready, at: Date.now() };
			readinessProbe = null;
			return ready;
		})();
	}

	return readinessProbe;
};

/** The question the proxy asks on behalf of every app it gates, asked here about the node's own pages.
 * Authelia weighs the session against its rules — including the networks it lets through without one —
 * and answers with all three things worth knowing: whether the request may proceed, where to send the
 * visitor otherwise (this node's login screen, because that is the portal it is told to name), and who
 * the request is from. Allowed with nobody named is the shape of a network let through unasked. */
const authorize = async ({ fqdn, uri = '/', clientAddress, cookie }) => {
	const autheliaUrl = encodeURIComponent(`https://${fqdn}/login`);
	const response = await fetch(`${BASE_URL}/api/authz/forward-auth?authelia_url=${autheliaUrl}`, {
		redirect: 'manual',
		headers: {
			...buildForwardedHeaders(fqdn, clientAddress),
			'x-forwarded-uri': uri,
			'x-forwarded-method': 'GET',
			...(cookie ? { cookie } : {})
		}
	});
	return {
		isAllowed: response.ok,
		location: response.headers.get('location'),
		identity: parseIdentity(response)
	};
};

/** Trades credentials for a session. A rejection is reported as one thing — Authelia distinguishes an
 * unknown user from a wrong password, and the login screen should not. */
const login = async ({ username, password, keepMeLoggedIn = false, fqdn, clientAddress }) => {
	const response = await request('/api/firstfactor', {
		fqdn,
		clientAddress,
		body: { username, password, keepMeLoggedIn }
	});
	const cookies = readSessionCookies(response);
	return {
		isAuthenticated: response.ok,
		cookies,
		sessionId: findSessionId(cookies.map((cookie) => { return cookie.split(';')[0]; }))
	};
};

const getSessionId = ({ cookie }) => {
	if (!cookie) {
		return undefined;
	}

	return findSessionId(String(cookie).split(';'));
};

const getCookieDomain = () => {
	if (!cookieDomain) {
		cookieDomain = traefikConfig.getClusterDomain();
	}

	return cookieDomain;
};

/** Ends the session and returns the cookies that clear it, which are Authelia's to write for the same
 * reason it writes the ones that create it. */
const logout = async ({ fqdn, cookie }) => {
	const response = await request('/api/logout', { fqdn, cookie, body: {} });
	return {
		isEnded: response.ok,
		status: response.status,
		cookies: readSessionCookies(response)
	};
};

export {
	getCookieDomain,
	getSessionId,
	isReady,
	authorize,
	login,
	logout
};
