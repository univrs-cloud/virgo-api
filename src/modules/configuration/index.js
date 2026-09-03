import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import configurationManager from './configuration_manager.js';
import * as trustedProxy from '../../utils/trusted_proxy.js';
import * as fleetState from '../../utils/fleet_state.js';

class ConfigurationModule extends BaseModule {
	constructor() {
		super('configuration');

		(async () => {
			await this.#loadConfiguration();
			configurationManager.broadcast(this);
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
			trustedProxy.set(configuration.trustedProxies);
			if (configuration.fleet) {
				configuration.fleet = { ...configuration.fleet, ...fleetState.getRuntimeState() };
			}
			this.setState('configuration', configuration);
		} catch (error) {
			console.error(`Error loading configuration:`, error);
		}
	}
}

export default () => {
	return new ConfigurationModule();
};
