const updateIdentifier = (job, plugin) => {
	let config = job.data.config;
	console.log(job, config, plugin);
	plugin.getInternalEmitter().emit('host:network:identifier:updated');
	return `Host updated.`;
};

const updateDefaultGateway = (job, plugin) => {
	let config = job.data.config;
	console.log(job, config, plugin);
	plugin.getInternalEmitter().emit('host:network:gateway:updated');
	return `Default gateway updated.`;
};

const updateInnterface = (job, plugin) => {
	let config = job.data.config;
	console.log(job, config, plugin);
	plugin.getInternalEmitter().emit('host:network:interface:updated');
	return `Network interface updated.`;
};

module.exports = {
	name: 'system_actions',
	onConnection(socket, plugin) {
		socket.on('host:network:identifier:update', async (config) => { 
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('host:network:identifier:update', { config, username: socket.username });
		});
		socket.on('host:network:gateway:update', async (config) => { 
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('host:network:gateway:update', { config, username: socket.username });
		});
		socket.on('host:network:interface:update', async (config) => { 
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('host:network:interface:update', { config, username: socket.username });
		});
	},
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:gateway:update': updateDefaultGateway,
		'host:network:interface:update': updateInnterface
	}
};
