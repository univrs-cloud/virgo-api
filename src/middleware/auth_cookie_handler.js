import * as trustedProxy from '../utils/trusted_proxy.js';
import * as authelia from '../utils/authelia.js';
import * as identity from '../utils/identity.js';

/**
 * Middleware for non-WebSocket HTTP requests only.
 * Sets the account cookie from the browser's session so the UI can show who is authenticated.
 * The session is Authelia's and this cookie is only a readable copy of what it says, which is why it
 * is written on every request rather than kept: a session that ended clears it on the next one.
 * Falls back to the headers a trusted proxy adds, for as long as the proxy is the one asking.
 */

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;

/** The same reach as the session it describes, so the two travel together — Authelia's cookie domain
 * is the node's name, and the host being asked for is either that name or something beneath it. A host
 * outside it, an address rather than a name, gets a cookie of its own: the browser would refuse one
 * scoped to a domain it is not visiting. */
const cookieDomain = async (req) => {
	const domain = await authelia.getCookieDomain({ fqdn: req.hostname });
	const isWithin = (domain && (req.hostname === domain || req.hostname.endsWith(`.${domain}`)));
	return (isWithin ? domain : req.hostname);
};

const cookieOptions = async (req) => {
	return {
		domain: await cookieDomain(req),
		encode: String,
		httpOnly: false,
		secure: true,
		sameSite: 'lax',
		maxAge: SIX_MONTHS_MS
	};
};

const serialize = (account) => {
	return Buffer.from(JSON.stringify(account)).toString('base64');
};

/** Removed rather than emptied, and at both reaches: the session it copies may have been established
 * when the node answered to another name, and a cookie left behind at that scope would be sent
 * alongside the one that replaces it. */
const clearAccount = async (req, res) => {
	const domain = await cookieDomain(req);
	res.clearCookie('account', { domain, path: '/' });
	if (domain !== req.hostname) {
		res.clearCookie('account', { domain: req.hostname, path: '/' });
	}
};

export default async (req, res, next) => {
	const account = await identity.getIdentity({ cookie: req.headers.cookie, fqdn: req.hostname });
	// Node’s HTTP API calls the TCP connection “socket” (not WebSocket). We need that connection’s
	// peer address so we can tell proxy (loopback) from direct clients.
	const isTrusted = trustedProxy.isFromTrustedProxy(req.socket?.remoteAddress);
	const proxied = (isTrusted && req.headers['remote-user'] ? {
		name: req.headers['remote-name'],
		user: req.headers['remote-user'],
		email: req.headers['remote-email'],
		groups: req.headers['remote-groups']?.split(',')
	} : undefined);
	const signedIn = (account.isAuthenticated ? {
		name: account.name,
		user: account.username,
		email: account.email,
		groups: account.groups
	} : proxied);
	// The cookie describes a session, so it lives exactly as long as one: written while there is
	// somebody to describe, taken away the moment there is not.
	if (signedIn) {
		res.cookie('account', serialize(signedIn), await cookieOptions(req));
	} else {
		await clearAccount(req, res);
	}
	res.header('Access-Control-Allow-Origin', '*');
	next();
};

export {
	clearAccount
};
