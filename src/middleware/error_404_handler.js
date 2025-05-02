/**
 * Middleware to handle 404 Not Found errors.
 * This should be placed after all other routes.
 */
module.exports = (req, res, next) => {
	res.status(404).send({ error: 'Not found.' });
};
