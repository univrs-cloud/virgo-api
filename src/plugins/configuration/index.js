const BasePlugin = require('../base');
const DataService = require('../../database/data_service');
const configurationManager = require('./configuration_manager');

class ConfigurationPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'configuration');

		this.getInternalEmitter()
			.on('configuration:updated', () => {
				this.#loadConfiguration();
				configurationManager.broadcast(this);
			});
	}

	init() {
		this.#loadConfiguration();
	}

	onConnection(socket) {
		configurationManager.emitToSocket(socket, this);
	}

	async #loadConfiguration() {
		try {
			const configuration = await DataService.getConfiguration();
			this.setState('configuration', configuration);
		} catch (error) {
			console.error('Error loading configuration:', error);
		}
	}
}

module.exports = (io) => {
	return new ConfigurationPlugin(io);
};
