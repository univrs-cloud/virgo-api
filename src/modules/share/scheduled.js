const register = (module) => {
	module.addJobSchedule(
		'shares:fetch',
		{ pattern: '0 */10 * * * *' }
	);
};

module.exports = {
	name: 'scheduled',
	register,
	jobs: {
		'shares:fetch': async (job, module) => {
			module.eventEmitter.emit('shares:updated');
			return ``;
		}
	}
};
