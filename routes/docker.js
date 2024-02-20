const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, check, validationResult } = require('express-validator');
const service = require('./../services/docker');

router
	.route('/v1/docker/containers')
	.get((req, res) => {
		service.containers()
			.then((containers) => {
				res.json(containers);
			})
			.catch((error) => {
				res.status(500).json({ error: error.name });
			});
	});

module.exports = router;
