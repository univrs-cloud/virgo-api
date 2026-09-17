import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import * as trustedProxy from '../../utils/trusted_proxy.js';
import * as fleetState from '../../utils/fleet_state.js';

class ConfigurationModule extends BaseModule {
	constructor() {
		super('configuration');

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

	onConnection(socket) {
		this.#emitConfiguration(socket);
	}

	#configurationFor(socket) {
		const configuration = this.getState('configuration') || {};
		if (!socket.isAuthenticated || !socket.isAdmin) {
			delete configuration.smtp;
			delete configuration.trustedProxies;
		}

		return configuration;
	}

	#emitConfiguration(socket) {
		try {
			socket.emit('configuration', this.#configurationFor(socket));
		} catch (error) {
			console.error(`Error emitting configuration to socket:`, error);
		}
	}

	#broadcastConfiguration() {
		try {
			for (const socket of this.nsp.sockets.values()) {
				socket.emit('configuration', this.#configurationFor(socket));
			}
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
