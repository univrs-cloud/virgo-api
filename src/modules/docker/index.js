import { promises as fs } from 'fs';
import path from 'path';
import camelcaseKeys from 'camelcase-keys';
import * as yaml from 'js-yaml';
import config from '../../../config.js';
import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';
import docker from '../../utils/docker_client.js';
import * as sanoid from '../../utils/sanoid.js';
import { isCoreApp } from '../../utils/core_apps.js';
import * as traefikConfig from '../../utils/traefik_config.js';
import { createLog } from '../../utils/log.js';

const log = createLog('docker');
const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/gm;

const CUSTOM_MARKER = 'custom';
const CUSTOM_NAME_PREFIX = 'custom-';
const TEMPLATES_FETCH_TIMEOUT_MS = 15000;
const VOLUME_PATTERN = /^\$\{APP_DIR(?::-[^}]*)?\}\/(.+?):([^:]+?)(:ro)?$/;
const PORT_PATTERN = /^(\d+):(\d+)\/(tcp|udp)$/;
const LABEL_PATTERN = /^traefik\.http\.(services|routers)\.[^.]+\.(loadbalancer\.server\.port|rule|middlewares)=(.*)$/;
const HOST_PATTERN = /Host\(`([^`]+)`\)/g;

const toCustomService = (name, definition, nodeDomain) => {
	const toList = (value) => { return (Array.isArray(value) ? value.map(String) : []); };
	const networks = toList(definition?.networks);
	const isPublic = networks.includes('virgo');
	const isInternal = networks.includes('internal');
	const labels = Object.fromEntries(toList(definition?.labels).map((label) => { return label.match(LABEL_PATTERN); }).filter(Boolean).map(([, , key, value]) => { return [key, value]; }));
	const hosts = [...String(labels.rule ?? '').matchAll(HOST_PATTERN)].map(([, host]) => { return host.replace('${DOMAIN}', nodeDomain).toLowerCase(); });
	const middlewares = String(labels.middlewares ?? '').split(',');
	const ports = [];
	for (const [, published, target, protocol] of toList(definition?.ports).map((port) => { return port.match(PORT_PATTERN); }).filter(Boolean)) {
		const existing = ports.find((port) => { return port.published === published && port.target === target; });
		if (existing) {
			existing.protocol = 'both';
		} else {
			ports.push({ published, target, protocol });
		}
	}

	return {
		name,
		image: String(definition?.image ?? ''),
		network: (isPublic && isInternal ? 'both' : (isInternal ? 'internal' : 'public')),
		domain: hosts[0] ?? '',
		port: String(labels['loadbalancer.server.port'] ?? ''),
		isPrivate: middlewares.includes('authelia@file'),
		isRedirectingWww: hosts.length > 1,
		restart: String(definition?.restart ?? 'unless-stopped'),
		ports,
		volumes: toList(definition?.volumes).map((volume) => { return volume.match(VOLUME_PATTERN); }).filter(Boolean).map(([, source, target, readOnly]) => {
			return { source, target, isReadOnly: Boolean(readOnly) };
		}),
		variables: toList(definition?.environment).map((variable) => { return { name: variable.split('=')[0] }; })
	};
};

const toEnvKey = (serviceName, variableName) => {
	return `${serviceName.replace(/-/g, '_').toUpperCase()}__${variableName}`;
};

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
	const visible = configured.map(({ env, custom, ...entry }) => {
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
	#configuredRefreshQueue = Promise.resolve();

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
		
		this.#queueConfiguredRefresh(async () => {
			await Promise.all([
				this.#loadConfigured(),
				this.#loadTemplates()
			]);
			await this.#loadAppSettings();
			this.#emitConfigured();
			this.#emitTemplates();
		});

		this.eventEmitter
			.on('app:containers:fetched', async () => {
				this.emitState('containers');
			})
			.on('app:resourceMetrics:fetched', async () => {
				this.emitState('appsResourceMetrics');
			})
			.on('configured:updated', () => {
				return this.#queueConfiguredRefresh(async () => {
					await this.#loadConfigured();
					await this.#loadAppSettings();
					this.#emitConfigured();
				});
			})
			.on('app:templates:fetch', () => {
				// Gated because this one is an hourly cron over a rarely-changing remote catalogue, not a
				// reaction to something having changed. No sortArrays: order is the catalogue's own.
				return this.#queueConfiguredRefresh(async () => {
					await this.#loadTemplates();
					this.#emitTemplates();
					await this.#loadAppSettings();
					this.#emitConfigured();
				});
			});
	}

	#queueConfiguredRefresh(refresh) {
		const queued = this.#configuredRefreshQueue.then(refresh);
		this.#configuredRefreshQueue = queued.catch((error) => {
			log.error('Error refreshing configured apps:', error);
		});
		return this.#configuredRefreshQueue;
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
		await this.#queueConfiguredRefresh(async () => {
			if (!this.getState('templates')) {
				await this.#loadTemplates();
				this.#emitTemplates();
			}
		});
		return this.toArray(this.getState('templates'));
	}

	async refreshTemplates() {
		let isLoaded = false;
		await this.#queueConfiguredRefresh(async () => {
			isLoaded = await this.#loadTemplates();
			this.#emitTemplates();
		});
		return (isLoaded ? this.toArray(this.getState('templates')) : []);
	}

	findTemplateByAppName(templates, appName) {
		const name = String(appName ?? '').toLowerCase();
		if (name.startsWith(CUSTOM_NAME_PREFIX)) {
			return undefined;
		}

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
	 * this node through what it reports: `[{ name, title, services, nextcloudApps }]`, or false while unknown. The
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
				// Only installed apps: an update is offered remotely as an app:stack:update job, which a compose
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

		const nextcloudAppUpdates = this.toArray(this.getState('nextcloud')?.appUpdates);
		const nextcloud = configured.find((entry) => { return entry.type === 'app' && String(entry.name).toLowerCase() === 'nextcloud'; });
		if (nextcloud && nextcloudAppUpdates.length > 0) {
			if (!apps.has(nextcloud.name)) {
				apps.set(nextcloud.name, { name: nextcloud.name, title: nextcloud.title || nextcloud.name, services: [] });
			}
			apps.get(nextcloud.name).nextcloudApps = nextcloudAppUpdates.map((update) => { return update.id; });
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
			log.error(`Error loading configured:`, error);
		}
	}

	async readAppEnv(name) {
		try {
			const content = await fs.readFile(path.join(this.appsDir, name, this.composeDir, '.env'), 'utf-8');
			return Object.fromEntries([...content.matchAll(ENV_LINE_PATTERN)].map(([, key, value]) => {
				return [key, value.replace(/\\(.)/g, (match, character) => { return ({ n: '\n', r: '\r' })[character] ?? character; })];
			}));
		} catch (error) {
			return null;
		}
	}

	async readCustomApp(name) {
		try {
			const compose = yaml.load(await fs.readFile(this.projectComposeFile(name), 'utf-8'));
			if (compose?.['x-virgo'] !== CUSTOM_MARKER) {
				return null;
			}

			const nodeDomain = String(traefikConfig.getClusterDomain() ?? '').toLowerCase();
			return {
				name,
				services: Object.entries(compose.services ?? {}).map(([service, definition]) => { return toCustomService(service, definition, nodeDomain); })
			};
		} catch (error) {
			return null;
		}
	}

	async #loadAppSettings() {
		const configured = this.getState('configured');
		if (!Array.isArray(configured)) {
			return;
		}

		const templates = this.toArray(this.getState('templates'));
		for (const entry of configured.filter((entry) => { return entry.type === 'app'; })) {
			delete entry.env;
			delete entry.custom;
			const custom = await this.readCustomApp(entry.name);
			if (custom) {
				const installedEnv = await this.readAppEnv(entry.name) ?? {};
				entry.custom = {
					...custom,
					services: this.toArray(custom.services).map((service) => {
						return {
							...service,
							variables: this.toArray(service.variables).map((variable) => {
								return { name: variable.name, value: installedEnv[toEnvKey(service.name, variable.name)] ?? '' };
							})
						};
					})
				};
				continue;
			}

			const template = this.findTemplateByAppName(templates, entry.name);
			if (!template || isCoreApp(entry.name)) {
				continue;
			}

			const fields = this.toArray(template.env).filter((field) => {
				return String(field?.name ?? '').toLowerCase() === 'domain' || (field?.editable === true && field.type !== 'password');
			});
			const installedEnv = await this.readAppEnv(entry.name);
			if (!installedEnv || fields.length === 0) {
				continue;
			}

			entry.env = Object.fromEntries(fields.filter((field) => { return Object.hasOwn(installedEnv, field.name); }).map((field) => { return [field.name, installedEnv[field.name]]; }));
		}
		this.setState('configured', configured);
	}

	async #loadTemplates() {
		try {
			const response = await fetch(config.apps.templatesUrl, { signal: AbortSignal.timeout(TEMPLATES_FETCH_TIMEOUT_MS) });
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			const templates = this.toArray(data.templates).filter((template) => {
				return this.toArray(template.platforms).some((platform) => { return String(platform).toLowerCase() === this.#platform; });
			});
			this.setState('templates', templates);
			return true;
		} catch (error) {
			if (!this.getState('templates')) {
				this.setState('templates', false);
			}
			log.error(`Error loading templates:`, error);
			return false;
		}
	}

	#emitConfigured() {
		this.emitState('configured');
	}

	#emitTemplates() {
		this.emitState('templates');
	}
}

export default () => {
	return new DockerModule();
};
