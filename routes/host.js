const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/host');

router
	.route('/v1/system/')
	.get((req, res) => {
		service.system()
			.then((system) => {
				res.json(system);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/cpu/')
	.get((req, res) => {
		service.cpu()
			.then((processor) => {
				res.json(processor);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/mem/')
	.get((req, res) => {
		service.mem()
			.then((memory) => {
				res.json(memory);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/fs/')
	.get((req, res) => {
		service.fs()
			.then((filesystems) => {
				res.json(filesystems);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/network/')
	.get((req, res) => {
		service.network()
			.then((interfaces) => {
				res.json(interfaces);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/ups/')
	.get((req, res) => {
		service.ups()
			.then((ups) => {
				res.json(ups);
			})
			.catch((error) => {
				if (error.message.toLowerCase().includes('remote i/o error')) {
					res.status(204).end();
					return;
				}
				
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/time/')
	.get((req, res) => {
		try {
			res.json(service.time());
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	})

module.exports = router;
