const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/host');

router
	.route('/v1/auth/')
	.get((req, res) => {
		res.json({
			name: req.headers['remote-name'],
			user: req.headers['remote-user'],
			email: req.headers['remote-email'],
			groups: req.headers['remote-groups'].split(',')
		});
	});

router
	.route('/v1/system/')
	.get((req, res) => {
		service.system()
			.then((system) => {
				res.json(system);
			});
	});

router
	.route('/v1/cpu/')
	.get((req, res) => {
		service.cpu()
			.then((processor) => {
				res.json(processor);
			});
	});

router
	.route('/v1/mem/')
	.get((req, res) => {
		service.mem()
			.then((memory) => {
				res.json(memory);
			});
	});

router
	.route('/v1/fs/')
	.get((req, res) => {
		service.fs()
			.then((filesystems) => {
				res.json(filesystems);
			});
	});

router
	.route('/v1/network/')
	.get((req, res) => {
		service.network()
			.then((interfaces) => {
				res.json(interfaces);
			});
	});

router
	.route('/v1/ups/')
	.get((req, res) => {
		service.ups()
			.then((ups) => {
				res.json(ups);
			});
	});

router
	.route('/v1/time/')
	.get((req, res) => {
		res.json(service.time());
	});

module.exports = router;
