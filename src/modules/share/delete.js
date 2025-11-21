const deleteShare = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, `Deleting share ${config.name}...`);
	// TODO: Implement actual share deletion logic
	module.eventEmitter.emit('shares:updated');
	return `Share ${config.name} deleted.`;
};

const onConnection = (socket, module) => {
	socket.on('share:delete', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('share:delete', { config, username: socket.username });
	});
};

module.exports = {
	name: 'delete',
	onConnection,
	jobs: {
		'share:delete': deleteShare
	}
};
