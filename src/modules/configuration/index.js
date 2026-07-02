import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import configurationManager from './configuration_manager.js';
import * as trustedProxy from '../../utils/trusted_proxy.js';

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

export default () => {
	return new ConfigurationModule();
};
