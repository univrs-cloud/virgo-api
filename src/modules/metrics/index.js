const { execa } = require('execa');
const BaseModule = require('../base');

class MetricsModule extends BaseModule {
	constructor() {
		super('metrics');

		(async () => {
			await this.#load();
		})();

		this.eventEmitter
			.on('metrics:enabled', async () => {
				await this.#load();
				this.nsp.emit('metrics', this.getState('metrics'));
			})
			.on('metrics:disabled', async () => {
				await this.#load();
				this.nsp.emit('metrics', this.getState('metrics'));
			});
	}

	async onConnection(socket) {
		socket.on('metrics:fetch', async () => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
	
			this.nsp.emit('metrics', this.getState('metrics'));
		});
	}

	async isPcpRunning() {
		try {
			const { stdout: status } = await execa('systemctl', ['is-active', 'pmcd']);
			if (status.trim() === 'active') {
				return true;
			}
		} catch {}
		
		try {
			await execa('pgrep', ['pmcd']);
			return true;
		} catch {}

		return false;
	}

	async #load() {
		let metrics = {
			isEnabled: await this.isPcpRunning()
		}
		this.setState('metrics', metrics);
	}
}

module.exports = () => {
	return new MetricsModule();
};
