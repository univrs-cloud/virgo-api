import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { createLog } from './utils/log.js';

const log = createLog('server');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACME_RETRY_DELAY_MS = 15000;

function createServer(app) {
	const options = {
		key: fs.readFileSync(path.join(__dirname, '../cert/key.pem')),
		cert: fs.readFileSync(path.join(__dirname, '../cert/cert.pem'))
	};
	return https.createServer(options, app);
}

function createAcmeServer(app) {
	const server = http.createServer(app);
	let retrying = null;

	server.on('error', (error) => {
		if (retrying) {
			return;
		}

		log.error(`ACME hook cannot bind ${config.acme.host}:${config.acme.port} (${error.code || error.message}); retrying in ${ACME_RETRY_DELAY_MS / 1000}s`);
		retrying = setTimeout(() => {
			retrying = null;
			server.listen(config.acme.port, config.acme.host, () => {
				log.info(`ACME hook recovered at http://${config.acme.host}:${config.acme.port}/acme`);
			});
		}, ACME_RETRY_DELAY_MS);
		retrying.unref();
	});

	return server;
}

export { createServer, createAcmeServer };
