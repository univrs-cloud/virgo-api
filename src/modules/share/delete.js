const deleteShare = async (job, plugin) => {
	const config = job.data.config;
	await plugin.updateJobProgress(job, `Deleting share ${config.name}...`);
	// TODO: Implement actual share deletion logic
	plugin.getInternalEmitter().emit('shares:updated');
	return `Share ${config.name} deleted.`;
};

module.exports = {
	name: 'delete',
	onConnection(socket, plugin) {
		socket.on('share:delete', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('share:delete', { config, username: socket.username });
		});
	},
	jobs: {
		'share:delete': deleteShare
	}
};
