const { execa } = require('execa');
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
			const { stdout } = await execa('virgo', ['stats', '--json']);
			this.setState('stats', JSON.parse(stdout));
		} catch (error) {
			console.error('indexer stats failed:', error);
		}
	}
}

module.exports = () => {
	return new IndexerModule();
};
