const { execa } = require('execa');

const updateIdentifier = async (job, plugin) => {
	let config = job.data.config;
	console.log(config);
	try {
		await execa('true');
	} catch (error) {
		throw new Error(`Host was not updated.`);
	}
	plugin.getInternalEmitter().emit('host:network:identifier:updated');
	return `Host updated.`;
};

const updateDefaultGateway = async (job, plugin) => {
	let config = job.data.config;
	console.log(config);
	try {
		await execa('true');
	} catch (error) {
		throw new Error(`Default gateway was not updated.`);
	}
	plugin.getInternalEmitter().emit('host:network:gateway:updated');
	return `Default gateway updated.`;
};

const updateInnterface = async (job, plugin) => {
	let config = job.data.config;
	console.log(config);
	try {
		await execa('true');
	} catch (error) {
		throw new Error(`Network interface was not updated.`);
	}
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
