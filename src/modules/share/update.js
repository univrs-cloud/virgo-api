const updateShare = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, `Updating share ${config.name}...`);
	// TODO: Implement actual share update logic
	module.eventEmitter.emit('shares:updated');
	return `Share ${config.name} updated.`;
};

module.exports = {
	name: 'update',
	onConnection(socket, module) {
		socket.on('share:update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await module.addJob('share:update', { config, username: socket.username });
		});
	},
	jobs: {
		'share:update': updateShare
	}
};
