const createShare = async (job, plugin) => {
	const config = job.data.config;
	await plugin.updateJobProgress(job, `Creating share ${config.name}...`);
	// TODO: Implement actual share creation logic
	await plugin.emitShares();
	return `Share ${config.name} created.`;
};

module.exports = {
	name: 'create',
	onConnection(socket, plugin) {
		socket.on('share:create', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('share:create', { config, username: socket.username });
		});
	},
	jobs: {
		'share:create': createShare
	}
};
