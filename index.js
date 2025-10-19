#!/usr/bin/env node

const config = require('./config');
const createApp = require('./src/app');
const createServer = require('./src/server');
const { initializeSocket } = require('./src/socket');
const modules = require('./src/modules');

try {
	const app = createApp();
	const server = createServer(app);
	initializeSocket(server);
	modules();

	server.listen(config.server.port, () => {
		console.log(`Server started at https://${config.server.host}:${config.server.port}`);
	});
} catch (error) {
	console.error('Failed to start server:', error);
    process.exit(1);
}
