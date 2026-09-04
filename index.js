#!/usr/bin/env node

import config from './config.js';
import { createApp, createAcmeApp } from './src/app.js';
import { createServer, createAcmeServer } from './src/server.js';
import * as socket from './src/socket.js';
import DataService from './src/database/data_service.js';
import modules from './src/modules/index.js';
import * as webrtcProxy from './src/utils/webrtc_proxy.js';

async function main() {
	const app = createApp();
	const server = createServer(app);
	socket.initializeSocket(server);
	const acmeApp = createAcmeApp();
	const acmeServer = createAcmeServer(acmeApp);
	await DataService.initialize();
	await modules();

	server.listen(config.server.port, config.server.host, () => {
		console.log(`Server started at https://${config.server.host}:${config.server.port}`);
	});
	acmeServer.listen(config.acme.port, config.acme.host, () => {
		console.log(`ACME server started at http://${config.acme.host}:${config.acme.port}/acme`);
	});
}

let stopping = false;
const stop = () => {
	if (stopping) {
		return;
	}
	stopping = true;
	webrtcProxy.shutdown();
	process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

main().catch((error) => {
	console.error('Failed to start server:', error);
	process.exit(1);
});
