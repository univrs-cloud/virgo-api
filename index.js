#!/usr/bin/env node

import config from './config.js';
import createApp from './src/app.js';
import createServer from './src/server.js';
import { initializeSocket } from './src/socket.js';
import modules from './src/modules/index.js';

async function main() {
	const app = createApp();
	const server = createServer(app);
	initializeSocket(server);
	await modules();

	server.listen(config.server.port, () => {
		console.log(`Server started at https://${config.server.host}:${config.server.port}`);
	});
}

main().catch((error) => {
	console.error('Failed to start server:', error);
	process.exit(1);
});
