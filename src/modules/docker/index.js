import path from 'path';
import camelcaseKeys from 'camelcase-keys';
import config from '../../../config.js';
import docker from '../../utils/docker_client.js';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

// Digest-only projection: Docker renders `status` as prose ("Up 4 minutes"), so it advances on its own clock
// even when nothing about the container changed. `state` says the same thing as an enum, which is all
// consumers read. Array order is handled by digesting with sortArrays, since the daemon reshuffles it.
const withoutRenderedStatus = (containers) => {
	if (!Array.isArray(containers)) {
		return containers;
	}

	return containers.map(({ status, ...container }) => { return container; });
};

class DockerModule extends BaseModule {
	#composeDir = '/opt/docker';
	#appsDataset = 'messier/apps';
	#appsDir;
	#appIconsDir = '/messier/.config/assets/img/apps';

	constructor() {
		super('docker');
		
		this.#appsDir = `/${this.#appsDataset}`;
		
		(async () => {
			await Promise.all([
				this.#loadConfigured(),
				this.#loadTemplates()
			]);
		})();

		this.eventEmitter
			.on('app:containers:fetched', async () => {
				this.emitChanged('app:containers', this.getState('containers'), { normalize: withoutRenderedStatus, sortArrays: true });
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
				// Gated because this one is an hourly cron over a rarely-changing remote catalogue, not a
				// reaction to something having changed. No sortArrays: order is the catalogue's own.
				await this.#loadTemplates();
				this.emitChanged('app:templates', this.getState('templates'));
			});
	}

	get composeDir() {
		return this.#composeDir;
	}

	get projectComposeFile() {
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

	/**
	 * Find all containers for an app by matching compose project name.
	 * Matches containers by compose project label (exact match).
	 * @param {string} appName - The app name to find containers for
	 * @returns {Promise<Array>} - Array of container objects (empty if none found)
	 */
	async findContainersByAppName(appName) {
		const containers = this.getState('containers');
		// Match by compose project label (exact match)
		// This ensures we match the exact project name and avoid false matches
		// e.g., "nextcloud" won't match containers from "nextcloud-hpb" project
		const projectContainers = containers.filter((container) => {
			return container.labels?.comDockerComposeProject === appName;
		});
		return projectContainers;
	}

	/** The available app updates grouped per app for remote consumers (the fleet), which only ever see
	 * this node through what it reports: `[{ name, title, services }]`, or false while unknown. The
	 * local `updates` state stays a flat container list, since that is what this node's own pages
	 * match against. */
	getAppUpdatesSummary() {
		const updates = this.getState('updates');
		if (!Array.isArray(updates)) {
			return false;
		}

		const configured = this.toArray(this.getState('configured'));
		const apps = new Map();
		for (const { app: appName, service } of updates) {
			if (!appName) {
				continue;
			}

			if (!apps.has(appName)) {
				// Only installed apps: an update is offered remotely as an app:update job, which a compose
				// project that isn't one of them has no way to run.
				const app = configured.find((entry) => { return entry.type === 'app' && entry.name === appName; });
				if (!app) {
					continue;
				}

				apps.set(appName, { name: appName, title: app.title || appName, services: [] });
			}
			const { services } = apps.get(appName);
			if (service && !services.includes(service)) {
				services.push(service);
			}
		}

		return [...apps.values()]
			.map((app) => { return { ...app, services: app.services.sort() }; })
			.sort((first, second) => { return first.title.localeCompare(second.title); });
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
			for (const entry of configured) {
				if (entry.type === 'app') {
					entry.dataset = `${this.appsDataset}/${entry.name}`;
				}
			}
			this.setState('configured', configured);
		} catch (error) {
			this.setState('configured', false);
			console.error(`Error loading configured:`, error);
		}
	}

	async #loadTemplates() {
		try {
			const response = await fetch(config.apps.templatesUrl);
			const data = await response.json();
			this.setState('templates', data.templates);
		} catch (error) {
			this.setState('templates', false);
			console.error(`Error loading templates:`, error);
		}
	}
}

export default () => {
	return new DockerModule();
};
