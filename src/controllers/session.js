import express from 'express';
import * as authelia from '../utils/authelia.js';
import * as identity from '../utils/identity.js';
import { clearAccount } from '../middleware/auth_cookie_handler.js';

/**
 * Signing in, out, and asking who is signed in. The session itself is Authelia's: these routes carry
 * credentials to it and its cookies back, and hold nothing in between.
 */

const router = express.Router();

/** The name the browser used. Authelia issues a cookie for the domain it is configured with, so a
 * request that arrives by any other name — an address, say — cannot be given a session at all. */
const requestFqdn = (req) => {
	return req.hostname;
};

/** The session that was just created, in the form a request carries it: the browser has not been given
 * these cookies yet, so asking who it is has to be done with the ones on their way to it. */
const asCookieHeader = (cookies) => {
	return cookies.map((cookie) => { return cookie.split(';')[0]; }).join('; ');
};

router.get('/session', async (req, res, next) => {
	try {
		res.json(await identity.getIdentity({ cookie: req.headers.cookie, fqdn: requestFqdn(req) }));
	} catch (error) {
		next(error);
	}
});

router.post('/session', async (req, res, next) => {
	const { username, password, keepMeLoggedIn } = req.body || {};
	if (!username || !password) {
		res.status(400).json({ message: 'A username and password are required.' });
		return;
	}

	try {
		const { isAuthenticated, cookies } = await authelia.login({
			username,
			password,
			keepMeLoggedIn: Boolean(keepMeLoggedIn),
			fqdn: requestFqdn(req),
			clientAddress: req.ip
		});
		if (!isAuthenticated) {
			// Whichever half was wrong, the answer is the same one.
			res.status(401).json({ message: 'Incorrect username or password.' });
			return;
		}

		res.setHeader('set-cookie', cookies);
		res.json(await identity.getIdentity({ cookie: asCookieHeader(cookies), fqdn: requestFqdn(req) }));
	} catch (error) {
		next(error);
	}
});

router.delete('/session', async (req, res, next) => {
	try {
		const { isEnded, status, cookies } = await authelia.logout({ cookie: req.headers.cookie, fqdn: requestFqdn(req) });
		identity.forget({ cookie: req.headers.cookie, fqdn: requestFqdn(req) });
		if (!isEnded) {
			console.error(`Could not end the session: Authelia answered ${status}.`);
			res.status(502).json({ message: 'Could not sign out.' });
			return;
		}

		// Appended rather than set: the middleware has already written the account cookie from a session
		// that was still live when the request arrived, and it is this answer that has to take it back.
		cookies.forEach((cookie) => { res.append('set-cookie', cookie); });
		await clearAccount(req, res);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

export default router;
