import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createServer(app) {
	const options = {
		key: fs.readFileSync(path.join(__dirname, '../cert/key.pem')),
		cert: fs.readFileSync(path.join(__dirname, '../cert/cert.pem'))
	};
	return https.createServer(options, app);
}

export default createServer;
