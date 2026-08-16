import * as setup from '../utils/setup_state.js';
import * as authelia from '../utils/authelia.js';
import { isPrivateAddress } from '../utils/private_address.js';

/**
 * Turns an unauthorized visitor away from the node's pages, the way the proxy does for every app it
 * gates. The proxy cannot do it here: this is where the login screen it redirects to lives, and a
 * request refused at the door would have nowhere to arrive. So the same question is asked from behind
 * it, and Authelia's answer — including the networks it lets through without a session — decides.
 *
 * The answer also names whoever is holding the session, so the account cookie is written from it here
 * rather than asked for a second time. Pages only: an address bar is what changes who is looking, and
 * the assets a page pulls in afterwards have nothing to add.
 */

// The pages that have to answer whoever asks: the login screen, and the routes it signs in through.
const OPEN_PATHS = ['/login', '/session'];
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;

const requestedUrl = (req) => {
	return `${req.protocol}://${req.hostname}${req.originalUrl}`;
};

/** The same reach as the session it describes, so the two travel together — Authelia's cookie domain
 * is the node's name, and the host being asked for is either that name or something beneath it. A host
 * outside it, an address rather than a name, gets a cookie of its own: the browser would refuse one
 * scoped to a domain it is not visiting. Nothing to ask before Authelia is installed, and nothing it
 * could answer: the wizard is reached by address. */
const cookieDomain = async (req) => {
	const domain = (setup.isCompleted() ? await authelia.getCookieDomain({ fqdn: req.hostname }) : undefined);
	const isWithin = (domain && (req.hostname === domain || req.hostname.endsWith(`.${domain}`)));
	return (isWithin ? domain : req.hostname);
};

/** A readable copy of who Authelia says is here, for the shell to build itself from before it has
 * spoken to anything. Removed rather than emptied when nobody is, and at both reaches: the session it
 * copies may have been established when the node answered to another name. */
const writeAccount = async (req, res, identity) => {
	const domain = await cookieDomain(req);
	if (!identity) {
		res.clearCookie('account', { domain, path: '/' });
		if (domain !== req.hostname) {
			res.clearCookie('account', { domain: req.hostname, path: '/' });
		}
		return;
	}

	const account = { name: identity.name, user: identity.username, email: identity.email, groups: identity.groups };
	res.cookie('account', Buffer.from(JSON.stringify(account)).toString('base64'), {
		domain,
		encode: String,
		httpOnly: false,
		secure: true,
		sameSite: 'lax',
		maxAge: SIX_MONTHS_MS
	});
};

export default async (req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	// The login screen and the routes it signs in through answer whoever asks, so there is nothing to
	// ask about them — and asking anyway leaves Authelia's log full of refusals nobody acted on.
	const isPage = (req.method === 'GET' && req.headers.accept?.includes('text/html'));
	if (!isPage || OPEN_PATHS.includes(req.path)) {
		next();
		return;
	}

	// Nobody is signed in to an appliance still being set up, and there is nothing installed to ask
	// about it: the wizard reaches the node by address, before any of this exists.
	if (!setup.isCompleted()) {
		await writeAccount(req, res);
		next();
		return;
	}

	try {
		const { isAllowed, location, identity } = await authelia.authorize({
			fqdn: req.hostname,
			uri: req.originalUrl,
			clientAddress: req.ip,
			cookie: req.headers.cookie
		});
		await writeAccount(req, res, identity);
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
