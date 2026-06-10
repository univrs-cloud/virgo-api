import express from 'express';
import authCookieHandler from './middleware/auth_cookie_handler.js';
import controllers from './controllers/index.js';
import error404Handler from './middleware/error_404_handler.js';
import errorHandler from './middleware/error_handler.js';

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(express.json());
	app.use(authCookieHandler);
	app.use(controllers);
	app.use(error404Handler);
	app.use(errorHandler);
	return app;
}

export default createApp;
