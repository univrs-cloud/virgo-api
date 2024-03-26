const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/docker');

router
	.route('/v1/docker/templates')
	.get((req, res) => {
		service.templates()
			.then((templates) => {
				res.json(templates);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message });
			});
	});

router
	.route('/v1/docker/configured')
	.get((req, res) => {
		service.configured()
			.then((configured) => {
				res.json(configured);
			})
			.catch((error) => {
				res.status(500).json({ error: error.message })
			});
	});

module.exports = router;
