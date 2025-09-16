module.exports = {
	onConnection(socket, plugin) {
		socket.on('share:update', async (config) => {
			await plugin.handleShareAction(socket, 'share:update', config);
		});
	},
	jobs: {
		'share:update': async (job, plugin) => {
			let config = job.data.config;
			await plugin.updateJobProgress(job, `Updating share ${config.name}...`);
			// TODO: Implement actual share update logic
			await plugin.emitShares();
			return `Share ${config.name} updated.`;
		}
	}
};
