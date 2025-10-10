#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');

const config = require('./config');
const plugins = require('./src/plugins');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json());
app.use(require('./src/controllers'));
app.use(require('./src/middleware/auth_cookie_handler'));
app.use(require('./src/middleware/error_404_handler'));
app.use(require('./src/middleware/error_handler'));

const options = {
	key: fs.readFileSync(path.join(__dirname, './cert/key.pem')),
	cert: fs.readFileSync(path.join(__dirname, './cert/cert.pem'))
};
const sslServer = https.createServer(options, app);
const io = new Server(sslServer);

plugins(io);

sslServer.listen(config.server.port, () => {
	console.log(`Server started at https://${config.server.host}:${config.server.port}`);
});
