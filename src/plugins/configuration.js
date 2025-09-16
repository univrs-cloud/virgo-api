const BasePlugin = require('./base');

class ConfigurationPlugin extends BasePlugin {
	configurationFile = '/var/www/virgo-api/configuration.json';

	constructor(io) {
		super(io, 'configuration');
	}

	onConnection(socket) {
		if (this.getState('configuration')) {
			let configuration = { ...this.getState('configuration') };
			if (!socket.isAuthenticated || !socket.isAdmin) {
				delete configuration.smtp;
			}
			this.getNsp().to(`user:${socket.username}`).emit('configuration', configuration);
		}
	}



}

module.exports = (io) => {
	return new ConfigurationPlugin(io);
};
