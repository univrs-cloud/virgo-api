const deleteShare = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Deleting share ${config.name}...`);
	// TODO: Implement actual share deletion logic
	await plugin.emitShares();
	return `Share ${config.name} deleted.`;
};

module.exports = {
	onConnection(socket, plugin) {
		socket.on('share:delete', async (config) => {
			await plugin.handleShareAction(socket, 'share:delete', config);
		});
	},
	jobs: {
		'share:delete': deleteShare
	}
};
