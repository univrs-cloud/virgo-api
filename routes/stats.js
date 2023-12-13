const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/stats');

router
	.route('/system/')
	.get((req, res) => {
		service.system()
			.then((system) => {
				res.json(system);
			});
	});

router
	.route('/cpu/')
	.get((req, res) => {
		service.cpu()
			.then((processor) => {
				res.json(processor);
			});
	});

router
	.route('/mem/')
	.get((req, res) => {
		service.mem()
			.then((memory) => {
				res.json(memory);
			});
	});

router
	.route('/fs/')
	.get((req, res) => {
		service.fs()
			.then((filesystems) => {
				res.json(filesystems);
			});
	});

router
	.route('/network/')
	.get((req, res) => {
		service.network()
			.then((interfaces) => {
				res.json(interfaces);
			});
	});

module.exports = router;
