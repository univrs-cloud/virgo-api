module.exports = async () => {
	const modules = [
		require('./job')(),
		require('./configuration')(),
		require('./host')(),
		require('./user')(),
		require('./docker')(),
		require('./bookmark')(),
		require('./share')(),
		require('./weather')()
	];

	return {
		modules
	};
};
