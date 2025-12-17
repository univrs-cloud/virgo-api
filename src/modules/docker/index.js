const path = require('path');
const docker = require('../../utils/docker_client');
const BaseModule = require('../base');
const DataService = require('../../database/data_service');

class DockerModule extends BaseModule {
	#composeDir = '/opt/docker';
	#appsDataset = 'messier/apps';
	#appsDir;
	#appIconsDir = '/var/www/virgo-ui/app/dist/assets/img/apps';

	constructor() {
		super('docker');
		
		this.#appsDir = `/${this.#appsDataset}`;
		
		(async () => {
			await this.#loadConfigured();
			await this.#loadTemplates();
		})();

		this.eventEmitter
			.on('app:containers:fetched', async () => {
				this.nsp.emit('app:containers', this.getState('containers'));
			})
			.on('app:resourceMetrics:fetched', async () => {
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('app:resourceMetrics', this.getState('appsResourceMetrics'));
					}
				}
			})
			.on('configured:updated', async () => {
				await this.#loadConfigured();
				this.nsp.emit('app:configured', this.getState('configured'));
			})
			.on('app:templates:fetch', async () => {
				await this.#loadTemplates();
				this.nsp.emit('app:templates', this.getState('templates'));
			});
	}

	get composeDir() {
		return this.#composeDir;
	}

	get composeFile() {
		return (composeProject) => {
			return path.join(this.composeDir, composeProject, 'docker-compose.yml');
		};
	}

	get appsDataset() {
		return this.#appsDataset;
	}

	get appsDir() {
		return this.#appsDir;
	}

	get appIconsDir() {
		return this.#appIconsDir;
	}

	async onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		pollingPlugin?.startPolling(this);

		if (this.getState('configured')) {
			socket.emit('app:configured', this.getState('configured'));
		}
		if (this.getState('containers')) {
			socket.emit('app:containers', this.getState('containers'));
		}
		if (this.getState('templates')) {
			socket.emit('app:templates', this.getState('templates'));
		}
		if (socket.isAuthenticated && socket.isAdmin) {
			if (this.getState('appsResourceMetrics')) {
				socket.emit('app:resourceMetrics', this.getState('appsResourceMetrics'));
			}
		}
	}

	async #loadConfigured() {
		try {
			const configured = await DataService.getConfigured();
			this.setState('configured', configured);
		} catch (error) {
			this.setState('configured', false);
			console.error(`Error loading configured:`, error);
		}
	}

	async #loadTemplates() {
		try {
			const response = await fetch(`https://apps.univrs.cloud/template.json`);
			const data = await response.json();
			this.setState('templates', data.templates);
		} catch (error) {
			this.setState('templates', false);
			console.error(`Error loading templates:`, error);
		}
	}
}

module.exports = () => {
	return new DockerModule();
};
