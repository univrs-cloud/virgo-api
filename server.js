#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const config = require('./config');
// const routes = require('./routes');
const emitters = require('./emitters');

const options = {
	key: fs.readFileSync(path.join(__dirname,'./cert/key.pem')),
	cert: fs.readFileSync(path.join(__dirname,'./cert/cert.pem'))
};
const app = express();
const sslServer = https.createServer(options, app);
const io = new Server(sslServer);
emitters(io);

app.disable('x-powered-by');

app.set('trust proxy', true);

app.use(bodyParser.json());

app.use((req, res, next) => {
	let hostname = req.hostname.split('.');
	hostname.splice(0, 1);
	let domain = hostname.join('.');
	if (req.headers['remote-user']) {
		const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;
		let account = {
			name: req.headers['remote-name'],
			user: req.headers['remote-user'],
			email: req.headers['remote-email'],
			groups: req.headers['remote-groups']?.split(',')
		};
		res.cookie('account', JSON.stringify(account), {
			domain: domain,
			encode: (val) => { return val; },
			httpOnly: false,
			secure: true,
			sameSite: 'lax',
			maxAge: SIX_MONTHS_MS
		});
	} else {
		res.clearCookie('account', {
			domain: domain
		});
	}
	res.header('Access-Control-Allow-Origin', '*');
	next();
});

app.use(express.static(path.join(__dirname, '..', '..', 'virgo-ui/app/dist')));
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, '..', '..', 'virgo-ui/dist/index.html'));
});

// app.use('/api/', routes);

app.use((req, res, next) => {
	res.status(404).send({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
	console.log(err);
	res.status(500).send({ error: 'Oops! Something went wrong.' });
});

sslServer.listen(config.server.port, () => {
	console.log(`Server started at https://localhost:${config.server.port}`);
});
