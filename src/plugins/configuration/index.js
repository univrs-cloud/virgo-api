const BasePlugin = require('../base');
const DataService = require('../../database/data_service');
const configurationManager = require('./configuration_manager');

class ConfigurationPlugin extends BasePlugin {
	constructor() {
		super('configuration');

		this.#loadConfiguration();

	this.getInternalEmitter()
		.on('configuration:updated', async () => {
			await this.#loadConfiguration();
			configurationManager.broadcast(this);
		});
	}

	onConnection(socket) {
		configurationManager.emitToSocket(socket, this);
	}

	async #loadConfiguration() {
		try {
			const configuration = await DataService.getConfiguration();
			this.setState('configuration', configuration);
		} catch (error) {
			console.error(`Error loading configuration:`, error);
		}
	}
}

module.exports = () => {
	return new ConfigurationPlugin();
};
