const createShare = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Creating share ${config.name}...`);
	// TODO: Implement actual share creation logic
	await plugin.emitShares();
	return `Share ${config.name} created.`;
};

module.exports = {
	onConnection(socket, plugin) {
		socket.on('share:create', async (config) => {
			await plugin.handleShareAction(socket, 'share:create', config);
		});
	},
	jobs: {
		'share:create': createShare
	}
};
