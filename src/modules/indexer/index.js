const { execa } = require('execa');
const camelcaseKeys = require('camelcase-keys').default;
const BaseModule = require('../base');

class IndexerModule extends BaseModule {
	constructor() {
		super('indexer');

		(async () => {
			await this.#loadStats();
		})();

		this.eventEmitter
			.on('indexer:index:updated', async () => {
				await this.#loadStats();
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('indexer:stats', this.getState('stats'));
					}
				}
			});
	}

	onConnection(socket) {
		if (socket.isAuthenticated && socket.isAdmin) {
			if (this.getState('stats')) {
				socket.emit('indexer:stats', this.getState('stats'));
			}
		}
	}

	async #loadStats() {
		try {
			const { stdout: stats } = await execa('virgo', ['stats', '--json']);
			this.setState('stats', camelcaseKeys(JSON.parse(stats), { deep: true }));
		} catch (error) {
			console.error('indexer stats failed:', error);
		}
	}
}

module.exports = () => {
	return new IndexerModule();
};
