import path from 'path';
import { promises as fs } from 'fs';
import dockerCompose from 'docker-compose';
import validator from 'validator';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import { isCoreApp } from '../../utils/core_apps.js';
import * as traefikConfig from '../../utils/traefik_config.js';

const ENV_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=/;

const envLine = (key, value) => {
	const escaped = String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n');
	return `${key}="${escaped}"`;
};

const isGated = (field) => {
	const policy = String(field.auth?.policy ?? '').toLowerCase();
	if (policy === '' || policy === 'none') {
		return false;
	}

	if (policy === 'optional') {
		return field.auth.default === true;
	}

	return true;
};

const isFleetDomain = (domain) => {
	return domain.endsWith(`.${config.fleet.zone}`);
};

const toValue = (field, value, appDomain) => {
	const text = String(value ?? '');
	if (field.type === 'radio' || field.type === 'select') {
		const option = (Array.isArray(field.select) ? field.select : []).find((option) => { return String(option.value).toLowerCase() === text.toLowerCase(); });
		if (!option) {
			throw new Error(`${field.label} has a choice that isn't offered.`);
		}

		return String(option.value);
	}

	if (text.trim() === '') {
		throw new Error(`${field.label} can't be empty.`);
	}

	if (field.name.toLowerCase() === 'domain') {
		const domain = text.trim().toLowerCase();
		if (!validator.isFQDN(domain, { require_tld: false })) {
			throw new Error(`'${text}' is not a valid domain name.`);
		}

		if (isFleetDomain(domain) && domain !== appDomain) {
			throw new Error(`The domain can only be ${appDomain}.`);
		}

		return domain;
	}

	return text;
};

const updateApp = async (job, module) => {
	const { config: request } = job.data;
	const name = String(request?.name ?? '');
	return await module.withAppLock(name, () => { return update(job, module, name, request?.env); });
};

const update = async (job, module, name, env) => {
	const app = await DataService.getApplication(name);
	if (!app) {
		throw new Error(`App not found.`);
	}

	const template = module.findTemplateByAppName(await module.getTemplates(), name);
	const fields = (Array.isArray(template?.env) ? template.env : []).filter((field) => { return field?.editable === true && !isGated(field); });
	if (isCoreApp(name) || fields.length === 0) {
		throw new Error(`${app.title} can't be edited.`);
	}

	const appDomain = String((String(template.scope ?? '').toLowerCase() === 'node' ? traefikConfig.getDomain() : traefikConfig.getClusterDomain()) ?? '').toLowerCase();
	const submitted = Object.entries(env ?? {});
	const changes = {};
	for (const field of fields) {
		const [, value] = submitted.find(([key]) => { return key.toLowerCase() === field.name.toLowerCase(); }) ?? [];
		if (value === undefined || (field.type === 'password' && String(value) === '')) {
			continue;
		}

		changes[field.name] = toValue(field, value, appDomain);
	}

	const domain = String(changes.DOMAIN ?? (await module.readAppEnv(name))?.DOMAIN ?? appDomain).toLowerCase();
	if (Object.hasOwn(changes, 'CERTRESOLVER') && domain === appDomain && isFleetDomain(domain)) {
		changes.CERTRESOLVER = '';
	}

	await module.updateJobProgress(job, `Saving ${app.title} settings...`);
	const composeProjectDir = path.join(module.appsDir, name, module.composeDir);
	const envFile = path.join(composeProjectDir, '.env');
	const remaining = { ...changes };
	const lines = (await fs.readFile(envFile, 'utf-8')).split('\n').filter((line) => { return line.trim() !== ''; }).map((line) => {
		const key = line.match(ENV_KEY_PATTERN)?.[1];
		if (!key || !Object.hasOwn(remaining, key)) {
			return line;
		}

		const updated = envLine(key, remaining[key]);
		delete remaining[key];
		return updated;
	});
	await fs.writeFile(envFile, [...lines, ...Object.entries(remaining).map(([key, value]) => { return envLine(key, value); })].join('\n'), 'utf-8');
	await module.ensureAppDirEnv(composeProjectDir);

	await module.updateJobProgress(job, `Restarting ${app.title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', name]],
		commandOptions: ['--remove-orphans'],
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});
	module.eventEmitter.emit('configured:updated');
	return `${app.title} settings saved.`;
};

export default {
	name: 'update',
	commands: {
		'app:update': { job: 'app:update' }
	},
	jobs: {
		'app:update': updateApp
	}
};
