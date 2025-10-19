const updateShare = async (job, plugin) => {
	const config = job.data.config;
	await plugin.updateJobProgress(job, `Updating share ${config.name}...`);
	// TODO: Implement actual share update logic
	plugin.getInternalEmitter().emit('shares:updated');
	return `Share ${config.name} updated.`;
};

module.exports = {
	name: 'update',
	onConnection(socket, plugin) {
		socket.on('share:update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('share:update', { config, username: socket.username });
		});
	},
	jobs: {
		'share:update': updateShare
	}
};
