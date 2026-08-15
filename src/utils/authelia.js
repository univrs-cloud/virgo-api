import config from '../../config.js';

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
// How long to wait before asking again, when Authelia had nothing to say about its cookie — it has
// nothing to say until it is installed.
const DOMAIN_RETRY = 60000;

let cookieDomain;
let askedAt = 0;

/** Authelia reads the request's target from these, and the client's address from X-Forwarded-For,
 * falling back to whoever opened the connection. Both matter: the target decides which session cookie
 * domain applies, and the address is what its rate limiting counts and what its network rules match —
 * left out, every login on the node looks like it came from virgo-api itself. */
const forwardedHeaders = (fqdn, clientAddress) => {
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
			...forwardedHeaders(fqdn, clientAddress),
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
const sessionCookies = (response) => {
	const cookies = response.headers.getSetCookie();
	const domain = cookies.map((cookie) => { return cookie.match(/;\s*Domain=([^;]+)/i)?.[1]; }).find(Boolean);
	if (domain) {
		cookieDomain = domain.trim().replace(/^\./, '');
	}

	return cookies;
};

/** Trades credentials for a session. A rejection is reported as one thing — Authelia distinguishes an
 * unknown user from a wrong password, and the login screen should not. */
const login = async ({ username, password, keepMeLoggedIn = false, fqdn, clientAddress }) => {
	const response = await request('/api/firstfactor', {
		fqdn,
		clientAddress,
		body: { username, password, keepMeLoggedIn }
	});
	return {
		isAuthenticated: response.ok,
		cookies: sessionCookies(response)
	};
};

/** Who the browser's cookie belongs to, or undefined when it carries no session. This asks about the
 * session itself rather than about access to a resource, so it answers the same on a network Authelia
 * lets through unauthenticated: bypassed clients are anonymous until they choose to sign in. */
const getSession = async ({ fqdn, cookie }) => {
	if (!cookie) {
		return undefined;
	}

	const response = await request('/api/state', { fqdn, cookie });
	if (!response.ok) {
		return undefined;
	}

	const { data } = await response.json();
	if (!data?.username || data?.authentication_level < 1) {
		return undefined;
	}

	return {
		username: data.username,
		authenticationLevel: data.authentication_level
	};
};

/** The domain Authelia's session cookie carries, so anything the node writes alongside it can be
 * scoped to reach exactly as far. Taken from the cookies themselves; until one has been seen, asking
 * to end a session nobody holds is a harmless way to be shown one, since the cookie that clears a
 * session names the same domain as the cookie that starts it. */
const getCookieDomain = async ({ fqdn }) => {
	if (cookieDomain || (Date.now() - askedAt) < DOMAIN_RETRY) {
		return cookieDomain;
	}

	askedAt = Date.now();
	try {
		await logout({ fqdn });
	} catch (error) {
		// Not installed yet, or not answering: the caller falls back to the name it was asked by.
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
		cookies: sessionCookies(response)
	};
};

export {
	getCookieDomain,
	getSession,
	login,
	logout
};
