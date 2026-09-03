import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

class IndexerModule extends BaseModule {
	constructor() {
		super('indexer');

		(async () => {
			await Promise.all([
				this.#loadDatasets(),
				this.#loadStats()
			]);
			this.#emitDatasets();
			this.#emitStats();
		})();

		this.eventEmitter
			.on('indexer:index:updated', async () => {
				await this.#loadStats();
				this.#emitStats();
			})
			.on('configuration:updated', async () => {
				await this.#loadDatasets();
				this.#emitDatasets();
			});
	}

	onConnection(socket) {
		if (socket.isAuthenticated && socket.isAdmin) {
			if (this.getState('stats')) {
				socket.emit('indexer:stats', this.getState('stats'));
			}
			if (this.getState('datasets')) {
				socket.emit('indexer:datasets', this.getState('datasets'));
			}
		}
	}

	async #loadDatasets() {
		try {
			const configuration = await DataService.getConfiguration();
			const datasets = (configuration.indexer ?? []);
			this.setState('datasets', datasets);
		} catch (error) {
			console.warn(`Could not load indexer datasets: ${error.shortMessage || error.message}`);
		}
	}

	async #loadStats() {
		try {
			const { stdout: stats } = await execa('virgo', ['indexer', 'stats', '--json']);
			this.setState('stats', camelcaseKeys(JSON.parse(stats || '{}'), { deep: true }));
		} catch (error) {
			console.warn(`Could not load indexer stats: ${error.shortMessage || error.message}`);
		}
	}

	#emitDatasets() {
		if (!this.getState('datasets')) {
			return;
		}

		this.emitChanged('indexer:datasets', this.getState('datasets'), {
			sortArrays: true,
			filter: (socket) => { return socket.isAuthenticated && socket.isAdmin; }
		});
	}

	#emitStats() {
		if (!this.getState('stats')) {
			return;
		}

		this.emitChanged('indexer:stats', this.getState('stats'), {
			filter: (socket) => { return socket.isAuthenticated && socket.isAdmin; }
		});
	}
}

export default () => {
	return new IndexerModule();
};
