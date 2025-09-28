const deleteShare = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Deleting share ${config.name}...`);
	// TODO: Implement actual share deletion logic
	await plugin.emitShares();
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
