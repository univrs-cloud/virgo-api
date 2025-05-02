/**
 * Global error handling middleware.
 * This should be the last middleware added to the Express app.
 */
module.exports = (error, req, res, next) => {
	console.error(error);
	const statusCode = error.status || 500;
	res.status(statusCode).send({
		error: error.message || 'Oops! Something went wrong.',
		stack: (process.env.NODE_ENV === 'development' ? error.stack : undefined)
	});
};
