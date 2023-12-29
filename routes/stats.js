const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/stats');

router
	.route('/3/system/')
	.get((req, res) => {
		service.system()
			.then((system) => {
				res.json(system);
			});
	});

router
	.route('/3/cpu/')
	.get((req, res) => {
		service.cpu()
			.then((processor) => {
				res.json(processor);
			});
	});

router
	.route('/3/mem/')
	.get((req, res) => {
		service.mem()
			.then((memory) => {
				res.json(memory);
			});
	});

router
	.route('/3/fs/')
	.get((req, res) => {
		service.fs()
			.then((filesystems) => {
				res.json(filesystems);
			});
	});

router
	.route('/3/network/')
	.get((req, res) => {
		service.network()
			.then((interfaces) => {
				res.json(interfaces);
			});
	});

router
	.route('/v1/devices/ups/')
	.get((req, res) => {
		service.ups()
			.then((stats) => {
				res.json(stats);
			});
	});

module.exports = router;
