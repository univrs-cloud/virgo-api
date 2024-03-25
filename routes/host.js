const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/host');

router
	.route('/v1/proxies/')
	.get((req, res) => {
		service.proxies()
			.then((proxies) => {
				res.json(proxies);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

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
	.route('/v1/updates/')
	.get((req, res) => {
		service.updates()
			.then((updates) => {
				res.json(updates);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

module.exports = router;
