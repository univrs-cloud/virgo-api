import path from 'path';
import { createWriteStream, promises as fs } from 'fs';
import stream from 'stream';
import { promisify } from 'util';
import camelcaseKeys from 'camelcase-keys';
import { execa } from 'execa';
import dockerCompose from 'docker-compose';
import * as yaml from 'js-yaml';
import validator from 'validator';
import config from '../../../config.js';
import docker from '../../utils/docker_client.js';
import DataService from '../../database/data_service.js';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import * as sanoid from '../../utils/sanoid.js';
import * as traefikConfig from '../../utils/traefik_config.js';
import { createLog } from '../../utils/log.js';
import { getActivePorts } from './port_conflicts.js';

const log = createLog('docker:custom');

const streamPipeline = promisify(stream.pipeline);

const CATEGORY = 'Custom';
const HOST_PORTS = ['22/tcp', '445/tcp', '3493/tcp'];
const NETWORKS = ['public', 'internal', 'both'];
const RESTART_POLICIES = ['unless-stopped', 'always', 'on-failure', 'no'];
const PROTOCOLS = ['tcp', 'udp', 'both'];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\/:@-]*$/i;
const FOLDER_PATTERN = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i;
const VARIABLE_PATTERN = /^[a-z_][a-z0-9_]*$/i;
const NAME_PREFIX = 'custom-';
const NAME_MAX_LENGTH = 63;
const ICON_URL_PATTERN = /^https:\/\/cdn\.jsdelivr\.net\/gh\/homarr-labs\/dashboard-icons\/(svg|png)\/[a-z0-9._-]+\.(svg|png)$/i;

const envLine = (key, value) => {
	const escaped = String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n');
	return `${key}="${escaped}"`;
};

const toEnvKey = (serviceName, variableName) => {
	return `${serviceName.replace(/-/g, '_').toUpperCase()}__${variableName}`;
};

const toArray = (value) => {
	return (Array.isArray(value) ? value : []);
};

const toProtocols = (protocol) => {
	return (protocol === 'both' ? ['tcp', 'udp'] : [protocol]);
};

const isFleetDomain = (domain) => {
	return domain.endsWith(`.${config.fleet.zone}`);
};

const getNodeDomain = () => {
	return String(traefikConfig.getClusterDomain() ?? '').toLowerCase();
};

const isNodeDomain = (domain, nodeDomain) => {
	return nodeDomain !== '' && domain.endsWith(`.${nodeDomain}`);
};

const canRedirectWww = (domain, nodeDomain) => {
	return domain !== '' && !isNodeDomain(domain, nodeDomain) && !domain.startsWith('www.');
};

const hasDuplicates = (values) => {
	return new Set(values).size !== values.length;
};

const loadTemplates = async (module) => {
	const templates = await module.getTemplates();
	if (!Array.isArray(module.getState('templates'))) {
		throw new Error(`The App center can't be reached right now, so the app can't be checked. Try again later.`);
	}

	return templates;
};

const isTemplateName = (templates, name) => {
	return templates.some((template) => {
		const templateName = template.name.toLowerCase();
		return templateName === name || (template.multiple === true && name.startsWith(`${templateName}-`));
	});
};

const isDatasetUsed = async (dataset) => {
	const { exitCode } = await execa('zfs', ['list', '-H', '-o', 'name', dataset], { reject: false });
	return exitCode === 0;
};

const isFolderUsed = async (folder) => {
	try {
		await fs.access(folder);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return false;
		}

		throw error;
	}
};

const getTakenHosts = async (module, templates, name) => {
	const fqdn = String(traefikConfig.getDomain() ?? '').toLowerCase();
	const nodeDomain = getNodeDomain();
	const templateHosts = templates.flatMap((template) => {
		const domain = (String(template.scope ?? '').toLowerCase() === 'node' ? fqdn : nodeDomain);
		return toArray(template.env)
			.filter((field) => { return String(field?.name ?? '').toLowerCase() === 'domain' && field.prefix; })
			.map((field) => { return `${field.prefix}${domain}`.toLowerCase(); });
	});
	const shortcutHosts = (await DataService.getShortcuts()).map((shortcut) => {
		try {
			return new URL(shortcut.url).hostname.toLowerCase();
		} catch (error) {
			return null;
		}
	});
	const customHosts = [];
	for (const application of await DataService.getApplications()) {
		if (String(application.name).toLowerCase() === name.toLowerCase()) {
			continue;
		}

		const custom = await module.readCustomApp(application.name);
		for (const service of toArray(custom?.services)) {
			customHosts.push(service.domain, ...(service.isRedirectingWww ? [`www.${service.domain}`] : []));
		}
	}
	return new Set([nodeDomain, fqdn, ...templateHosts, ...shortcutHosts, ...customHosts].filter(Boolean).map((host) => { return host.toLowerCase(); }));
};

const getTakenPorts = async (name) => {
	const containers = camelcaseKeys(await docker.listContainers({ all: true }), { deep: true });
	return new Set([...HOST_PORTS, ...getActivePorts(containers, name)]);
};

const toPort = (value, label) => {
	const port = String(value ?? '').trim();
	if (!validator.isPort(port)) {
		throw new Error(`${label} must be a port number.`);
	}

	return String(Number(port));
};

const toService = (service, nodeDomain) => {
	const name = String(service?.name ?? '').trim().toLowerCase();
	if (!NAME_PATTERN.test(name)) {
		throw new Error(`'${name}' is not a valid service name. Use lowercase letters, numbers and hyphens.`);
	}

	const image = String(service.image ?? '').trim();
	if (!IMAGE_PATTERN.test(image)) {
		throw new Error(`The ${name} service needs an image name, like nginx:latest.`);
	}

	const network = String(service.network ?? '').toLowerCase();
	if (!NETWORKS.includes(network)) {
		throw new Error(`The ${name} service needs a network.`);
	}

	const restart = String(service.restart ?? '').toLowerCase();
	if (!RESTART_POLICIES.includes(restart)) {
		throw new Error(`The ${name} service has a restart choice that isn't offered.`);
	}

	const isPublic = (network !== 'internal');
	const domain = (isPublic ? String(service.domain ?? '').trim().toLowerCase() : '');
	if (domain !== '') {
		if (!validator.isFQDN(domain, { require_tld: false })) {
			throw new Error(`'${domain}' is not a valid domain name.`);
		}

		if (isFleetDomain(domain) && !(isNodeDomain(domain, nodeDomain) && !domain.slice(0, -(nodeDomain.length + 1)).includes('.'))) {
			throw new Error(`'${domain}' can only be a subdomain of ${nodeDomain}.`);
		}
	}

	const volumes = toArray(service.volumes).map((volume) => {
		const source = String(volume?.source ?? '').trim().replace(/^\/+|\/+$/g, '');
		if (!FOLDER_PATTERN.test(source) || source.split('/').some((segment) => { return segment === '.' || segment === '..'; })) {
			throw new Error(`'${source}' is not a valid folder for the ${name} service.`);
		}

		const target = String(volume?.target ?? '').trim();
		if (!target.startsWith('/') || /\s|:/.test(target)) {
			throw new Error(`'${target}' is not a valid path in the ${name} service.`);
		}

		return { source, target, isReadOnly: volume?.isReadOnly === true };
	});
	if (hasDuplicates(volumes.map((volume) => { return volume.target; }))) {
		throw new Error(`The ${name} service uses a path in its container twice.`);
	}

	const variables = toArray(service.variables).map((variable) => {
		const variableName = String(variable?.name ?? '').trim();
		if (!VARIABLE_PATTERN.test(variableName)) {
			throw new Error(`'${variableName}' is not a valid variable name for the ${name} service.`);
		}

		return { name: variableName, value: String(variable?.value ?? '') };
	});
	if (hasDuplicates(variables.map((variable) => { return variable.name.toLowerCase(); }))) {
		throw new Error(`The ${name} service has the same variable twice.`);
	}

	const ports = (isPublic ? toArray(service.ports) : []).map((port) => {
		const protocol = String(port?.protocol ?? '').toLowerCase();
		if (!PROTOCOLS.includes(protocol)) {
			throw new Error(`The ${name} service has a port protocol that isn't offered.`);
		}

		return { published: toPort(port?.published, 'Node port'), target: toPort(port?.target, 'Container port'), protocol };
	});

	return {
		name,
		image,
		network,
		domain,
		port: (domain === '' ? '' : toPort(service.port, `The web port of the ${name} service`)),
		isPrivate: (isNodeDomain(domain, nodeDomain) && service.isPrivate === true),
		isRedirectingWww: (canRedirectWww(domain, nodeDomain) && service.isRedirectingWww === true),
		restart,
		ports,
		volumes,
		variables
	};
};

const toCustomApp = async (module, request, name, templates) => {
	const nodeDomain = getNodeDomain();
	const services = toArray(request?.services).map((service) => { return toService(service, nodeDomain); });
	if (services.length === 0) {
		throw new Error(`The app needs at least one service.`);
	}

	if (hasDuplicates(services.map((service) => { return service.name; }))) {
		throw new Error(`Each service needs its own name.`);
	}

	const takenHosts = await getTakenHosts(module, templates, name);
	const hosts = services.flatMap((service) => {
		return (service.domain === '' ? [] : [service.domain, ...(service.isRedirectingWww ? [`www.${service.domain}`] : [])]);
	});
	const takenHost = hosts.find((host) => { return takenHosts.has(host); });
	if (takenHost) {
		throw new Error(`${takenHost} is already in use.`);
	}

	if (hasDuplicates(hosts)) {
		throw new Error(`Each service needs its own domain.`);
	}

	const takenPorts = await getTakenPorts(name);
	const ports = services.flatMap((service) => {
		return service.ports.flatMap((port) => { return toProtocols(port.protocol).map((protocol) => { return `${port.published}/${protocol}`; }); });
	});
	const takenPort = ports.find((port) => { return takenPorts.has(port); });
	if (takenPort) {
		throw new Error(`Port ${takenPort} is already in use.`);
	}

	if (hasDuplicates(ports)) {
		throw new Error(`Each port can only be opened once.`);
	}

	return { name, services };
};

const toCompose = (module, app) => {
	const nodeDomain = getNodeDomain();
	const networks = new Set();
	const services = Object.fromEntries(app.services.map((service) => {
		const definition = { image: service.image };
		if (service.variables.length > 0) {
			definition.environment = service.variables.map((variable) => { return `${variable.name}=\${${toEnvKey(service.name, variable.name)}}`; });
		}

		if (service.volumes.length > 0) {
			definition.volumes = [...service.volumes]
				.sort((first, second) => { return Number(second.isReadOnly) - Number(first.isReadOnly); })
				.map((volume) => { return `\${APP_DIR:-${module.appsDir}/${app.name}}/${volume.source}:${volume.target}${volume.isReadOnly ? ':ro' : ''}`; });
		}

		if (service.domain !== '') {
			const router = `${app.name}-${service.name}`;
			const isOnNodeDomain = isNodeDomain(service.domain, nodeDomain);
			const host = (isOnNodeDomain ? `${service.domain.slice(0, -(nodeDomain.length + 1))}.\${DOMAIN}` : service.domain);
			const middlewares = [
				...(service.isRedirectingWww ? [`${router}-www`] : []),
				'secure-headers@file',
				...(service.isPrivate ? ['authelia@file'] : [])
			];
			definition.labels = [
				'traefik.enable=true',
				'traefik.docker.allowNonRunning=true',
				`traefik.http.services.${router}.loadbalancer.server.port=${service.port}`,
				`traefik.http.routers.${router}.service=${router}`,
				`traefik.http.routers.${router}.rule=${service.isRedirectingWww ? `Host(\`${host}\`) || Host(\`www.${host}\`)` : `Host(\`${host}\`)`}`,
				`traefik.http.routers.${router}.entrypoints=https`,
				`traefik.http.routers.${router}.tls.certresolver=${isOnNodeDomain ? '${CERTRESOLVER:+${CERTRESOLVER}}' : 'le'}`,
				`traefik.http.routers.${router}.middlewares=${middlewares.join(',')}`,
				...(service.isRedirectingWww
					? [
						`traefik.http.middlewares.${router}-www.redirectregex.regex=^https://www[.]${host.replace(/\./g, '[.]')}/(.*)`,
						`traefik.http.middlewares.${router}-www.redirectregex.replacement=https://${host}/$\${1}`,
						`traefik.http.middlewares.${router}-www.redirectregex.permanent=true`
					]
					: [])
			];
		}

		if (service.ports.length > 0) {
			definition.ports = service.ports.flatMap((port) => {
				return toProtocols(port.protocol).map((protocol) => { return `${port.published}:${port.target}/${protocol}`; });
			});
		}

		definition.networks = [
			...(service.network !== 'public' ? ['internal'] : []),
			...(service.network !== 'internal' ? ['virgo'] : [])
		];
		definition.networks.forEach((network) => { networks.add(network); });
		definition.restart = service.restart;
		return [service.name, definition];
	}));
	return yaml.dump({
		'x-virgo': 'custom',
		services,
		networks: {
			...(networks.has('internal') ? { internal: { internal: true } } : {}),
			...(networks.has('virgo') ? { virgo: { external: true } } : {})
		}
	}, { lineWidth: -1, noRefs: true });
};

const deploy = async (job, module, app, title) => {
	const composeProjectDir = path.join(module.appsDir, app.name, module.composeDir);
	await module.updateJobProgress(job, `Writing ${title} project...`);
	await fs.mkdir(composeProjectDir, { recursive: true });
	await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), toCompose(module, app), 'utf-8');
	const nodeDomain = getNodeDomain();
	const certresolver = (isFleetDomain(nodeDomain) ? '' : traefikConfig.getCertresolver());
	const variables = app.services.flatMap((service) => {
		return service.variables.map((variable) => { return envLine(toEnvKey(service.name, variable.name), variable.value); });
	});
	await fs.writeFile(path.join(composeProjectDir, '.env'), [envLine('DOMAIN', nodeDomain), envLine('CERTRESOLVER', certresolver), ...variables].join('\n'), 'utf-8');
	await module.ensureAppDirEnv(composeProjectDir);

	await module.updateJobProgress(job, `Downloading ${title}...`);
	const parsePullProgress = dockerPullProgressParser();
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', app.name], ['--progress', 'json']],
		callback: (chunk) => {
			const progress = parsePullProgress(chunk);
			if (progress) {
				module.updateJobProgress(job, `Downloading ${title}...`, progress);
			}
		}
	});
	await module.updateJobProgress(job, `Starting ${title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', app.name]],
		commandOptions: ['--remove-orphans'],
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});
};

const toIconUrl = (value) => {
	const url = String(value ?? '').trim();
	if (url === '') {
		return null;
	}

	const match = url.match(ICON_URL_PATTERN);
	if (!match || match[1].toLowerCase() !== match[2].toLowerCase()) {
		throw new Error(`The icon can only come from the icon picker.`);
	}

	return url;
};

const saveIcon = async (job, module, name, title, url) => {
	const extension = url.split('.').pop().toLowerCase();
	const icon = `${name}.${extension}`;
	await module.updateJobProgress(job, `Saving ${title} icon...`);
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}

		await fs.mkdir(module.appIconsDir, { recursive: true });
		await streamPipeline(response.body, createWriteStream(path.join(module.appIconsDir, icon)));
		await fs.rm(path.join(module.appIconsDir, `${name}.${(extension === 'svg' ? 'png' : 'svg')}`), { force: true });
		return icon;
	} catch (error) {
		log.error(`Could not save the ${name} icon:`, error);
		return null;
	}
};

const toSnapshotRule = async (value) => {
	const name = String(value ?? '').trim().toLowerCase();
	if (name === '') {
		return null;
	}

	const rule = (await sanoid.getRules()).find((rule) => { return rule.name.toLowerCase() === name; });
	if (!rule) {
		throw new Error(`The protection rule ${value} no longer exists.`);
	}

	return rule.name;
};

const removeStorage = async (job, module, name, title, dataset) => {
	await module.updateJobProgress(job, `Removing ${title} storage space...`);
	await execa('docker', ['compose', '-p', name, 'down', '--remove-orphans'], { cwd: path.join(module.appsDir, name, module.composeDir), reject: false });
	const { exitCode, stderr } = await execa('zfs', ['destroy', '-r', dataset], { reject: false });
	if (exitCode !== 0) {
		log.error(`Could not remove the ${name} storage space:`, stderr);
	}
};

const installCustomApp = async (job, module) => {
	const { config: request } = job.data;
	const title = String(request?.name ?? '').trim().toLowerCase();
	const name = `${NAME_PREFIX}${title}`;
	if (!NAME_PATTERN.test(title) || name.length > NAME_MAX_LENGTH) {
		throw new Error(`'${title}' is not a valid app name. Use lowercase letters, numbers and hyphens.`);
	}

	return await module.withAppLock(name, () => { return install(job, module, name, title, request); });
};

const install = async (job, module, name, title, request) => {
	const templates = await loadTemplates(module);
	if (isTemplateName(templates, name)) {
		throw new Error(`The name ${title} is kept for an App center app. Pick another name.`);
	}

	if (await DataService.hasApplication(name)) {
		throw new Error(`An app named ${title} already exists.`);
	}

	const dataset = `${module.appsDataset}/${name}`;
	const hasDataset = await isDatasetUsed(dataset);
	const isLeftOver = (hasDataset && Boolean(await module.readCustomApp(name)));
	if ((hasDataset && !isLeftOver) || (!hasDataset && await isFolderUsed(path.join(module.appsDir, name)))) {
		throw new Error(`The storage space for ${title} is already in use. Pick another name.`);
	}

	const app = await toCustomApp(module, request, name, templates);
	const snapshotRule = await toSnapshotRule(request?.snapshotRule);
	const iconUrl = toIconUrl(request?.icon);
	await module.updateJobProgress(job, `${title} installation starting...`);
	if (isLeftOver) {
		await module.updateJobProgress(job, `Using the existing storage space for ${title}...`);
	} else {
		await module.updateJobProgress(job, `Creating storage space for ${title}...`);
		try {
			await execa('zfs', ['create', dataset]);
		} catch (error) {
			throw new Error(`Could not create storage space for ${title}.`);
		}
	}

	try {
		await deploy(job, module, app, title);
	} catch (error) {
		if (!isLeftOver) {
			await removeStorage(job, module, name, title, dataset);
		}
		throw error;
	}
	await module.updateJobProgress(job, `Setting up ${title} snapshots...`);
	try {
		if (!snapshotRule || !(await module.hasDatasetMounts(name))) {
			await sanoid.setMode(dataset, 'disabled');
		} else {
			await sanoid.setMode(dataset, 'enabled');
			await sanoid.setRule(dataset, snapshotRule);
		}
	} catch (error) {
		log.error(`Could not set the ${name} snapshots configuration:`, error);
	}

	const icon = (iconUrl ? await saveIcon(job, module, name, title, iconUrl) : null);
	await module.updateJobProgress(job, `Updating apps registry...`);
	await DataService.setApplication({
		name,
		title,
		icon,
		category: CATEGORY,
		canBeRemoved: true,
		canEmbed: null
	});
	module.eventEmitter.emit('configured:updated');
	module.eventEmitter.emit('app:installed', { name });
	return `${title} installed.`;
};

const updateCustomApp = async (job, module) => {
	const { config: request } = job.data;
	const name = `${NAME_PREFIX}${String(request?.name ?? '').trim().toLowerCase()}`;
	return await module.withAppLock(name, () => { return update(job, module, name, request); });
};

const update = async (job, module, name, request) => {
	const existingApp = await DataService.getApplication(name);
	if (!existingApp || !(await module.readCustomApp(name))) {
		throw new Error(`App not found.`);
	}

	const app = await toCustomApp(module, request, name, await loadTemplates(module));
	const iconUrl = toIconUrl(request?.icon);
	await module.updateJobProgress(job, `${existingApp.title} update starting...`);
	await deploy(job, module, app, existingApp.title);
	if (iconUrl) {
		const icon = await saveIcon(job, module, name, existingApp.title, iconUrl);
		if (icon) {
			await DataService.updateApplication(name, { icon });
		}
	}
	module.eventEmitter.emit('configured:updated');
	return `${existingApp.title} updated.`;
};

export default {
	name: 'custom',
	commands: {
		'app:custom:install': { job: 'app:custom:install' },
		'app:custom:update': { job: 'app:custom:update' }
	},
	jobs: {
		'app:custom:install': installCustomApp,
		'app:custom:update': updateCustomApp
	}
};
