import { promises as fs } from 'fs';
import path from 'path';
import camelcaseKeys from 'camelcase-keys';
import dockerCompose from 'docker-compose';
import config from '../../../config.js';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import docker from '../../utils/docker_client.js';
import * as sanoid from '../../utils/sanoid.js';

// Digest-only projection: Docker renders `status` as prose ("Up 4 minutes"), so it advances on its own clock
// even when nothing about the container changed. `state` says the same thing as an enum, which is all
// consumers read. Array order is handled by digesting with sortArrays, since the daemon reshuffles it.
const withoutRenderedStatus = (containers) => {
	if (!Array.isArray(containers)) {
		return containers;
	}

	return containers.map(({ status, ...container }) => { return container; });
};

const configuredFor = (configured, tier) => {
	const visible = configured.map((entry) => {
		if (!entry.traefik) {
			return entry;
		}

		const { backendUrl, configFile, ...traefik } = entry.traefik;
		return { ...entry, traefik };
	});
	return (tier === 'admin' ? configured : visible);
};

class DockerModule extends BaseModule {
	#composeDir = '.docker';
	#appsDataset = 'messier/apps';
	#appsDir;
	#appIconsDir = '/messier/.config/assets/img/apps';
	#platform = (process.arch === 'x64' ? 'amd64' : process.arch);
	#appLocks = new Map();

	constructor() {
		super('docker');
		
		this.#appsDir = `/${this.#appsDataset}`;

		this.declareState({
			configured: {
				event: 'app:configured',
				when: (value) => { return Boolean(value); },
				project: configuredFor
			},
			containers: { event: 'app:containers', gated: true, normalize: withoutRenderedStatus, sortArrays: true },
			templates: { event: 'app:templates', gated: true, when: (value) => { return Boolean(value); } },
			appsResourceMetrics: { event: 'app:resourceMetrics', audience: 'admin' },
			updates: { event: 'app:updates', audience: 'admin', gated: true }
		});
		
		(async () => {
			await Promise.all([
				this.#loadConfigured(),
				this.#loadTemplates()
			]);
			this.#emitConfigured();
			this.#emitTemplates();
		})();

		this.eventEmitter
			.on('app:containers:fetched', async () => {
				this.emitState('containers');
			})
			.on('app:resourceMetrics:fetched', async () => {
				this.emitState('appsResourceMetrics');
			})
			.on('configured:updated', async () => {
				await this.#loadConfigured();
				this.#emitConfigured();
			})
			.on('app:templates:fetch', async () => {
				// Gated because this one is an hourly cron over a rarely-changing remote catalogue, not a
				// reaction to something having changed. No sortArrays: order is the catalogue's own.
				await this.#loadTemplates();
				this.#emitTemplates();
			});
	}

	get composeDir() {
		return this.#composeDir;
	}

	get projectComposeFile() {
		return (composeProject) => {
			return path.join(this.appsDir, composeProject, this.composeDir, 'docker-compose.yml');
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

	async withAppLock(name, task) {
		const previous = this.#appLocks.get(name) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(task);
		this.#appLocks.set(name, current);
		try {
			return await current;
		} finally {
			if (this.#appLocks.get(name) === current) {
				this.#appLocks.delete(name);
			}
		}
	}

	async getTemplates() {
		if (!this.getState('templates')) {
			await this.#loadTemplates();
			this.#emitTemplates();
		}
		return this.toArray(this.getState('templates'));
	}

	findTemplateByAppName(templates, appName) {
		const name = String(appName ?? '').toLowerCase();
		const exact = templates.find((template) => { return template.name.toLowerCase() === name; });
		if (exact) {
			return exact;
		}

		return templates.find((template) => {
			return template.multiple === true && name.startsWith(`${template.name.toLowerCase()}-`);
		});
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

	async ensureAppDirEnv(composeProjectDir) {
		const envFile = path.join(composeProjectDir, '.env');
		let content = '';
		try {
			content = await fs.readFile(envFile, 'utf-8');
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}

		const lines = content.split('\n').filter((line) => { return line.trim() !== '' && !line.trim().toLowerCase().startsWith('app_dir='); });
		lines.push(`APP_DIR="${path.dirname(composeProjectDir)}"`);
		const next = lines.join('\n');
		if (next !== content) {
			await fs.writeFile(envFile, next, 'utf-8');
		}
	}

	/**
	 * Bring an app's compose project up on its current files and start every service, except the ones the
	 * user stopped: those are recreated but left stopped, and a paused one is paused again. A service that
	 * exited on its own was not stopped by the user, so it is started. A dependency of a service that is
	 * started is started too, even if the user stopped it, since the service would not work without it.
	 * When the user stopped every service, the app stays stopped.
	 * @param {String} appName - The app whose stopped services are kept stopped
	 * @param {Array} containers - The app's containers as they were before the project was changed
	 * @param {Object} options - docker-compose options (cwd, composeOptions, commandOptions, callback)
	 */
	async upKeepingServiceStates(appName, containers, options) {
		// A service whose replicas differ takes the most active state: running, then paused, then stopped.
		const rank = { stopped: 0, paused: 1, running: 2 };
		const states = new Map();
		for (const container of containers) {
			const service = container.labels?.comDockerComposeService;
			if (!service) {
				continue;
			}

			const state = String(container.state ?? '').toLowerCase();
			const current = (['running', 'restarting'].includes(state) ? 'running' : (state === 'paused' ? 'paused' : 'stopped'));
			if (!states.has(service) || rank[current] > rank[states.get(service)]) {
				states.set(service, current);
			}
		}

		// The user's word only counts while the service is still stopped: one started since then is started again.
		const projectOptions = { cwd: options.cwd, composeOptions: options.composeOptions };
		const { data } = await dockerCompose.configServices(projectOptions);
		const services = data.services;
		const stopped = (await DataService.getStoppedServices(appName)).filter((service) => {
			return services.includes(service) && states.get(service) === 'stopped';
		});
		await DataService.setStoppedServices(appName, stopped);
		const paused = services.filter((service) => { return states.get(service) === 'paused'; });
		if (stopped.length === 0 && paused.length === 0) {
			await dockerCompose.upAll(options);
			return;
		}

		await dockerCompose.createAll(options);
		const allStopped = [...states.keys()].every((service) => { return stopped.includes(service); });
		const toStart = services.filter((service) => { return !stopped.includes(service); });
		if (allStopped || toStart.length === 0) {
			return;
		}

		await dockerCompose.upMany(toStart, options);
		for (const service of paused) {
			await dockerCompose.pauseOne(service, projectOptions);
		}
	}

	async hasDatasetMounts(appName) {
		const containers = camelcaseKeys(await docker.listContainers({ all: true }), { deep: true });
		const prefix = `${this.appsDir}/${appName}/`.toLowerCase();
		return containers.some((container) => {
			return String(container.labels?.comDockerComposeProject ?? '').toLowerCase() === String(appName).toLowerCase() && this.toArray(container.mounts).some((mount) => {
				return String(mount.source ?? '').toLowerCase().startsWith(prefix);
			});
		});
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

	async #loadConfigured() {
		try {
			const configured = await DataService.getConfigured();
			const apps = configured.filter((entry) => { return entry.type === 'app'; });
			for (const entry of apps) {
				entry.dataset = `${this.appsDataset}/${entry.name}`;
			}
			const policies = await sanoid.getPolicies(apps.map((entry) => { return entry.dataset; }));
			for (const entry of apps) {
				entry.snapshotPolicy = policies[entry.dataset];
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
			const templates = this.toArray(data.templates).filter((template) => {
				return this.toArray(template.platforms).some((platform) => { return String(platform).toLowerCase() === this.#platform; });
			});
			this.setState('templates', templates);
		} catch (error) {
			this.setState('templates', false);
			console.error(`Error loading templates:`, error);
		}
	}

	#emitConfigured() {
		this.emitState('configured');
	}

	#emitTemplates() {
		this.emitState('templates');
	}
}

export { DockerModule };

export default () => {
	return new DockerModule();
};
