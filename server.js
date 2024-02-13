#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const express = require('express');
const https = require('https');
const bodyParser = require('body-parser');
const config = require('./config');
const routes = require('./routes');

const app = express();
const options = {
	key: fs.readFileSync(path.join(__dirname,'./cert/key.pem')),
	cert: fs.readFileSync(path.join(__dirname,'./cert/cert.pem'))
};

app.disable('x-powered-by');

app.set('trust proxy', true);

app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, '..', '..', 'virgo-ui/app/dist')));
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, '..', '..', 'virgo-ui/dist/index.html'));
});

app.use('/api/', routes);

app.use((req, res, next) => {
	res.status(404).send({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
	console.log(err);
	res.status(500).send({ error: 'Oops! Something went wrong.' });
});

const sslServer = https.createServer(options, app);
sslServer.listen(config.server.port, () => {
	console.log(`Server started at https://localhost:${config.server.port}`);
});
