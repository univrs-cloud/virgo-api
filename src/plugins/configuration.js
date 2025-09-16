const BasePlugin = require('./base');

class ConfigurationPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'configuration');
	}

	init() {
		this.configurationFile = '/var/www/virgo-api/configuration.json';
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
