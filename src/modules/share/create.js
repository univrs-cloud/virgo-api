const createShare = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, `Creating share ${config.name}...`);
	// TODO: Implement actual share creation logic
	module.getInternalEmitter().emit('shares:updated');
	return `Share ${config.name} created.`;
};

module.exports = {
	name: 'create',
	onConnection(socket, module) {
		socket.on('share:create', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await module.addJob('share:create', { config, username: socket.username });
		});
	},
	jobs: {
		'share:create': createShare
	}
};
