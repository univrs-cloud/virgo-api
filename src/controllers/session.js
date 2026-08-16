import express from 'express';
import * as authelia from '../utils/authelia.js';

/**
 * Signing in and out. The session itself is Authelia's: these routes carry credentials to it and its
 * cookies back, and hold nothing in between. Who is signed in is not asked here — the answer travels
 * in the account cookie, written from the session on every request.
 */

const router = express.Router();

/** The name the browser used. Authelia issues a cookie for the domain it is configured with, so a
 * request that arrives by any other name — an address, say — cannot be given a session at all. */
const requestFqdn = (req) => {
	return req.hostname;
};

router.post('/session', async (req, res, next) => {
	const { username, password, keepMeLoggedIn } = req.body || {};
	if (!username || !password) {
		res.sendStatus(400);
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
			// Whichever half was wrong, the answer is the same one, and the status is all of it.
			res.sendStatus(401);
			return;
		}

		res.setHeader('set-cookie', cookies);
		res.sendStatus(200);
	} catch (error) {
		next(error);
	}
});

router.delete('/session', async (req, res, next) => {
	try {
		const { isEnded, status, cookies } = await authelia.logout({ cookie: req.headers.cookie, fqdn: requestFqdn(req) });
		if (!isEnded) {
			console.error(`Could not end the session: Authelia answered ${status}.`);
			res.sendStatus(502);
			return;
		}

		// The account cookie is written from a page's own authorization, and the next page will find no
		// session to describe; this answer only has to carry Authelia's cookies away.
		res.setHeader('set-cookie', cookies);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

export default router;
