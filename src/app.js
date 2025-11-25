const express = require('express');
const authCookieHandler = require('./middleware/auth_cookie_handler');
const controllers = require('./controllers');
const error404Handler = require('./middleware/error_404_handler');
const errorHandler = require('./middleware/error_handler');

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

module.exports = createApp;
