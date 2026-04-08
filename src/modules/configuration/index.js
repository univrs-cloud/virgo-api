const BaseModule = require('../base');
const DataService = require('../../database/data_service');
const configurationManager = require('./configuration_manager');
const trustedProxy = require('../../utils/trusted_proxy');

class ConfigurationModule extends BaseModule {
	constructor() {
		super('configuration');

		(async () => {
			await this.#loadConfiguration();
		})();

		this.eventEmitter
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
			trustedProxy.clear();
			const trustedProxies = Array.isArray(configuration.trustedProxies) ? configuration.trustedProxies : [];
			trustedProxies.forEach((proxy) => {
				trustedProxy.add(proxy);
			});
			this.setState('configuration', configuration);
		} catch (error) {
			console.error(`Error loading configuration:`, error);
		}
	}
}

module.exports = () => {
	return new ConfigurationModule();
};
