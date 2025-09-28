const BasePlugin = require('./base');
const configurationManager = require('./configuration/configuration_manager');
const DataService = require('../database/data_service');

class ConfigurationPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'configuration');
	}

	init() {
		this.loadConfiguration();

		this.getInternalEmitter().on('configuration:updated', () => {
			this.loadConfiguration();
		});
	}

	onConnection(socket) {
		configurationManager.emitToSocket(socket, this);
	}

	async loadConfiguration() {
		try {
			const configuration = await DataService.getConfiguration();
			this.setState('configuration', configuration);
		} catch (error) {
			console.error('Error loading configuration:', error);
		}
	}

	async broadcastConfiguration() {
		await configurationManager.broadcast(this);
	}
}

module.exports = (io) => {
	return new ConfigurationPlugin(io);
};
