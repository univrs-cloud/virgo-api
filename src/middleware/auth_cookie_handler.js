const { isFromTrustedProxy } = require('../utils/trusted_proxy');

/**
 * Middleware for non-WebSocket HTTP requests only.
 * Sets the account cookie from request headers so the UI can show who is authenticated.
 * Only sets the cookie when the request came from proxy (loopback),
 * so remote-user is not spoofed.
 */
module.exports = (req, res, next) => {
	const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;
	const cookieOptions = {
		domain: req.hostname,
		encode: String,
		httpOnly: false,
		secure: true,
		sameSite: 'lax',
		maxAge: SIX_MONTHS_MS
	};
	// Node’s HTTP API calls the TCP connection “socket” (not WebSocket). We need that connection’s
	// peer address so we can tell proxy (loopback) from direct clients.
	if (isFromTrustedProxy(req.socket?.remoteAddress) && req.headers['remote-user']) {
		const account = {
			name: req.headers['remote-name'],
			user: req.headers['remote-user'],
			email: req.headers['remote-email'],
			groups: req.headers['remote-groups']?.split(',')
		};
		const serializedAccount = Buffer.from(JSON.stringify(account)).toString('base64');
		res.cookie('account', serializedAccount, cookieOptions);
	} else {
		// Clear the cookie if remote-user header is not present
		res.cookie('account', '', cookieOptions);
	}
	res.header('Access-Control-Allow-Origin', '*');
	next();
};
