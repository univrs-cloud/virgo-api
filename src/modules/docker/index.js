const path = require('path');
const dockerode = require('dockerode');
const BaseModule = require('../base');
const DataService = require('../../database/data_service');

const docker = new dockerode();

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
			.on('configured:updated', async () => {
				await this.#loadConfigured();
				this.nsp.emit('app:configured', this.getState('configured'));
			})
			.on('templates:fetch', async () => {
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
			this.nsp.emit('app:configured', this.getState('configured'));
		}
		if (this.getState('containers')) {
			this.nsp.emit('app:containers', this.getState('containers'));
		}
		if (this.getState('appsResourceMetrics')) {
			this.nsp.emit('app:resourceMetrics', this.getState('appsResourceMetrics'));
		}
		if (this.getState('templates')) {
			this.nsp.emit('app:templates', this.getState('templates'));
		}
	}

	getRawGitHubUrl(repositoryUrl, filePath, branch = 'main') {
		const { hostname, pathname } = new URL(repositoryUrl);
		const [owner, repository] = pathname?.split('/')?.filter(Boolean);
		if (hostname.includes('github.com')) {
			const rawHostname = hostname.replace('github.com', 'raw.githubusercontent.com');
			return `https://${rawHostname}/${owner}/${repository}/${branch}/${filePath}`;
		}
	
		throw new Error(`Unsupported apps repository.`);
	};

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
