import * as authelia from '../utils/authelia.js';
import * as setup from '../utils/setup_state.js';

/**
 * Turns an unauthorized visitor away from the node's pages, the way the proxy does for every app it
 * gates. The proxy cannot do it here: this is where the login screen it redirects to lives, and a
 * request refused at the door would have nowhere to arrive. So the same question is asked from behind
 * it, and Authelia's answer — including the networks it lets through without a session — decides.
 */

// The pages that have to answer whoever asks: the login screen, and the routes it signs in through.
const OPEN_PATHS = ['/login', '/session'];
const PRIVATE_PATTERNS = [
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^::1$/,
	/^f[cd]/i,
	/^fe80:/i
];

/** Whether the client is on the same premises as the node — the networks it is administered from. */
const isPrivateAddress = (address) => {
	const normalized = (address || '').replace(/^::ffff:/i, '');
	return PRIVATE_PATTERNS.some((pattern) => { return pattern.test(normalized); });
};

const requestedUrl = (req) => {
	return `${req.protocol}://${req.hostname}${req.originalUrl}`;
};

export default async (req, res, next) => {
	const isPage = (req.method === 'GET' && req.headers.accept?.includes('text/html'));
	if (!isPage || OPEN_PATHS.includes(req.path) || !setup.isCompleted()) {
		next();
		return;
	}

	try {
		const { isAllowed, location } = await authelia.authorize({
			fqdn: req.hostname,
			uri: req.originalUrl,
			clientAddress: req.ip,
			cookie: req.headers.cookie
		});
		if (isAllowed) {
			next();
			return;
		}

		// Authelia names where to send them, carrying the address they were trying to reach; without an
		// answer the login screen is still the place to be, just without the way back.
		res.redirect(location || `/login?rd=${encodeURIComponent(requestedUrl(req))}`);
	} catch (error) {
		// Nobody can be identified while Authelia is unreachable, so nobody is let in. The exception is
		// the local network: Authelia lives on the pool, and the pages that repair a node whose apps are
		// down are these ones — refusing them from the premises as well would leave no way back.
		if (isPrivateAddress(req.ip)) {
			next();
			return;
		}

		res.status(503).type('text/plain').send('Authentication is unavailable on this node.');
	}
};
