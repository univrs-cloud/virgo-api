#!/usr/bin/env node

const config = require('./config');
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const routes = require('./routes');
const apiVersion = 3;


const app = express();

app.disable('x-powered-by');

app.set('trust proxy', true);

app.use(helmet());

app.use(bodyParser.json());

app.use(`/api/${apiVersion}/`, routes);
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
