import express from 'express';
import authorizationHandler from './middleware/authorization_handler.js';
import controllers from './controllers/index.js';
import error404Handler from './middleware/error_404_handler.js';
import errorHandler from './middleware/error_handler.js';
import * as trustedProxy from './utils/trusted_proxy.js';

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	// Only the proxy in front of us may claim who the client is. Trusting the whole chain would take a
	// forwarding header the browser wrote itself, and that address is what Authelia rate limits by and
	// what its network rules match.
	app.set('trust proxy', (address) => { return trustedProxy.isFromTrustedProxy(address); });
	app.use(express.json());
	app.use(authorizationHandler);
	app.use(controllers);
	app.use(error404Handler);
	app.use(errorHandler);
	return app;
}

export default createApp;
