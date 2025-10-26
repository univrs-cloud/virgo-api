const deleteShare = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, `Deleting share ${config.name}...`);
	// TODO: Implement actual share deletion logic
	module.getInternalEmitter().emit('shares:updated');
	return `Share ${config.name} deleted.`;
};

module.exports = {
	name: 'delete',
	onConnection(socket, module) {
		socket.on('share:delete', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await module.addJob('share:delete', { config, username: socket.username });
		});
	},
	jobs: {
		'share:delete': deleteShare
	}
};
