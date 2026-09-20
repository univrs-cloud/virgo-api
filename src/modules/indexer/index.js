import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

class IndexerModule extends BaseModule {
	constructor() {
		super('indexer');

		this.declareState({
			datasets: { event: 'indexer:datasets', audience: 'admin', gated: true, sortArrays: true, when: (value) => { return Boolean(value); } },
			stats: { event: 'indexer:stats', audience: 'admin', gated: true, when: (value) => { return Boolean(value); } }
		});

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
		this.emitState('datasets');
	}

	#emitStats() {
		this.emitState('stats');
	}
}

export default () => {
	return new IndexerModule();
};
