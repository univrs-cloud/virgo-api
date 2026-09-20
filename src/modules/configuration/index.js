import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import * as trustedProxy from '../../utils/trusted_proxy.js';
import * as fleetState from '../../utils/fleet_state.js';

const configurationFor = (configuration, tier) => {
	const { smtp, trustedProxies, ...visible } = (configuration ?? {});
	return (tier === 'admin' ? (configuration ?? {}) : visible);
};

class ConfigurationModule extends BaseModule {
	constructor() {
		super('configuration');

		this.declareState({
			configuration: {
				event: 'configuration',
				when: () => { return true; },
				project: configurationFor
			}
		});

		(async () => {
			await this.#loadConfiguration();
			this.#broadcastConfiguration();
		})();

		this.eventEmitter
			.on('configuration:updated', async () => {
				await this.#loadConfiguration();
				this.#broadcastConfiguration();
			});
	}

	#broadcastConfiguration() {
		try {
			this.emitState('configuration');
		} catch (error) {
			console.error(`Error broadcasting configuration:`, error);
		}
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
