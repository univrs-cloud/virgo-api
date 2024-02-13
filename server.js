#!/usr/bin/env node

const config = require('./api/config');
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const routes = require('./api/routes');

const app = express();

app.disable('x-powered-by');

app.set('trust proxy', true);

app.use(helmet());

app.use(bodyParser.json());

app.use(express.static('dist'));
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'dist/index.html'));
});

app.use('/api/', routes);

app.use((req, res, next) => {
	res.status(404).send({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
	console.log(err);
	res.status(500).send({ error: 'Oops! Something went wrong.' });
});

const server = app.listen(config.server.port, () => {
	console.log(`Server started at http://localhost:${server.address().port}`);
});
