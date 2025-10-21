const dockerode = require('dockerode');
const BasePlugin = require('../base');
const DataService = require('../../database/data_service');

const docker = new dockerode();

class DockerPlugin extends BasePlugin {
	#composeDir = '/opt/docker';

	constructor() {
		super('docker');
		
		this.#loadConfigured();
		this.#loadTemplates();

		this.getInternalEmitter()
			.on('configured:updated', async () => {
				await this.#loadConfigured();
				this.getNsp().emit('app:configured', this.getState('configured'));
			})
			.on('templates:fetch', async () => {
				await this.#loadTemplates();
				this.getNsp().emit('app:templates', this.getState('templates'));
			});
	}

	get composeDir() {
		return this.#composeDir;
	};

	async onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		pollingPlugin.startPolling(socket, this);

		if (this.getState('configured')) {
			this.getNsp().emit('app:configured', this.getState('configured'));
		}
		if (this.getState('containers')) {
			this.getNsp().emit('app:containers', this.getState('containers'));
		}
		if (this.getState('templates')) {
			this.getNsp().emit('app:templates', this.getState('templates'));
		}
	}

	getRawGitHubUrl(repositoryUrl, filePath, branch = 'main') {
		const { hostname, pathname } = new URL(repositoryUrl);
		const [owner, repository] = pathname.split('/').filter(Boolean);
		if (hostname.includes('github.com')) {
			const rawHostname = hostname.replace('github.com', 'raw.githubusercontent.com');
			return `https://${rawHostname}/${owner}/${repository}/${branch}/${filePath}`;
		}
	
		throw new Error(`Unsupported apps repository.`);
	};

	async #loadConfigured() {
		try {
			const configuration = await DataService.getConfigured();
			this.setState('configured', { configuration });
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
	return new DockerPlugin();
};
