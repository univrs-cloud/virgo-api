/**
 * Middleware to handle 404 Not Found errors.
 * This should be placed after all other routes.
 */
export default (req, res, next) => {
	res.status(404).send({ message: 'Not found.' });
};
