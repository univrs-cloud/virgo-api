import express from 'express';
import authorizationHandler from './middleware/authorization_handler.js';
import controllers from './controllers/index.js';
import error404Handler from './middleware/error_404_handler.js';
import errorHandler from './middleware/error_handler.js';
import frameAncestorsHandler from './middleware/frame_ancestors_handler.js';
import * as trustedProxy from './utils/trusted_proxy.js';
import { relayAcmeChallenge } from './modules/configuration/fleet.js';

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	// Only the proxy in front of us may claim who the client is. Trusting the whole chain would take a
	// forwarding header the browser wrote itself, and that address is what Authelia rate limits by and
	// what its network rules match.
	app.set('trust proxy', (address) => { return trustedProxy.isFromTrustedProxy(address); });
	app.use(frameAncestorsHandler);
	app.use(express.json());
	app.use(authorizationHandler);
	app.use(controllers);
	app.use(error404Handler);
	app.use(errorHandler);
	return app;
}

function createAcmeApp() {
	const app = express();
	app.disable('x-powered-by');
	app.use(express.json({ limit: '16kb' }));
	app.post('/acme/present', challenge('present'));
	app.post('/acme/cleanup', challenge('cleanup'));
	app.use((request, response) => { response.status(404).json({ message: 'Not found' }); });
	return app;
}

const challenge = (action) => {
	return async (request, response) => {
		const fqdn = String(request.body?.fqdn || '').trim().replace(/\.$/, '');
		const value = String(request.body?.value || '').trim();
		if (!fqdn || !value) {
			response.status(400).json({ message: 'fqdn and value are required' });
			return;
		}

		try {
			await relayAcmeChallenge(action, { fqdn, value });
			response.status(200).json({ status: 'succeeded' });
		} catch (error) {
			response.status(502).json({ message: error.message });
		}
	};
};

export { createApp, createAcmeApp };
