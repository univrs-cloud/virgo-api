'use strict';

const { execaSync } = require('execa');
const { InvalidArgumentError } = require('commander');
const { Queue } = require('bullmq');
const config = require('../config');
const DataService = require('../src/database/data_service');
const { getQueueName } = require('../src/queues');

const getHostFqdn = () => {
	try {
		const { stdout, failed } = execaSync('hostname', ['-f'], {
			reject: false,
			stripFinalNewline: true
		});
		if (failed) {
			return '';
		}
		const line = (stdout || '').trim().split(/\r?\n/)[0];
		return line || '';
	} catch {
		return '';
	}
};

const getExploreDefaultDisplay = (field, hostFqdn) => {
	if (field.name?.toLowerCase() === 'domain') {
		const fromTemplate = resolveEnvDefault(field);
		if (fromTemplate !== '') {
			return fromTemplate;
		}
		return hostFqdn;
	}
	return resolveEnvDefault(field);
};

const isSelectLikeField = (field) => {
	return Array.isArray(field.select) && field.select.length > 0;
};

const resolveEnvDefault = (field) => {
	if (isSelectLikeField(field)) {
		const chosen = field.select.find((option) => { return option.default === true; });
		if (chosen) {
			return chosen.value;
		}
		return field.select[0]?.value ?? '';
	}
	if (field.default !== undefined && field.default !== null) {
		return field.default;
	}
	return '';
};

const selectOptionsForJson = (field) => {
	return field.select.map((option) => {
		return {
			value: option.value,
			text: option.text,
			default: option.default === true
		};
	});
};

const displayEnvValue = (value) => {
	if (value === '') {
		return 'empty';
	}
	return String(value);
};

const formatSelectOptionsShort = (select) => {
	return select.map((option) => { return displayEnvValue(option.value); }).join(', ');
};

const envFieldToRow = (field, hostFqdn) => {
	const row = {
		name: field.name,
		type: field.type,
		label: field.label,
		default: getExploreDefaultDisplay(field, hostFqdn)
	};
	if (isSelectLikeField(field)) {
		row.options = selectOptionsForJson(field);
	}
	return row;
};

const fetchTemplates = async () => {
	const response = await fetch(config.apps.templatesUrl);
	if (!response.ok) {
		throw new Error(`Could not load the app list (${response.status} ${response.statusText}).`);
	}
	const data = await response.json();
	if (!data || !Array.isArray(data.templates)) {
		throw new Error('Could not read the app list (unexpected response).');
	}
	return data.templates;
};

const getTemplateEnvVarNames = (template) => {
	const fields = template.env || [];
	const names = fields
		.map((field) => { return field.name; })
		.filter((name) => { return name != null && String(name).length > 0; });
	return [...new Set(names)];
};

const getMissingEnvKeys = (template, env) => {
	const required = getTemplateEnvVarNames(template);
	return required.filter((key) => { return !Object.hasOwn(env, key); });
};

const exploreApps = async (opts) => {
	let templates;
	try {
		templates = await fetchTemplates();
	} catch (err) {
		console.error(err.message || err);
		process.exitCode = 1;
		return;
	}

	let installedNames;
	try {
		const installed = await DataService.getApplications();
		installedNames = new Set(installed.map((row) => { return row.name; }));
	} catch (err) {
		console.error('Could not read which applications are already installed:', err.message || err);
		process.exitCode = 1;
		return;
	}

	const available = templates.filter((template) => { return !installedNames.has(template.name); });
	const hostFqdn = getHostFqdn();

	if (opts.json) {
		const payload = available.map((template) => {
			const env = (template.env || []).map((field) => { return envFieldToRow(field, hostFqdn); });
			return {
				name: template.name,
				title: template.title,
				description: template.description,
				env
			};
		});
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	if (available.length === 0) {
		console.log('No installable apps (everything is already installed).');
		return;
	}

	for (const template of available) {
		console.log(`${template.title} (${template.name})`);
		if (template.description) {
			console.log(`  ${template.description}`);
		}
		const envFields = template.env || [];
		if (envFields.length === 0) {
			console.log('  (no env fields)');
		} else {
			for (const field of envFields) {
				const row = envFieldToRow(field, hostFqdn);
				const defStr = displayEnvValue(row.default);
				if (row.options) {
					console.log(`  ${row.name}=${defStr} (options: ${formatSelectOptionsShort(field.select)})`);
				} else {
					console.log(`  ${row.name}=${defStr}`);
				}
			}
		}
		console.log('');
	}
};

const enqueueDockerJob = async (jobName, data, doneMessage) => {
	const queueName = getQueueName('docker');
	const connection = {
		host: config.redis.host,
		port: config.redis.port
	};
	const queue = new Queue(queueName, { connection });
	try {
		await queue.add(jobName, data);
		console.log(doneMessage);
	} catch (err) {
		console.error(err);
		process.exitCode = 1;
	} finally {
		await queue.close();
	}
};

const parseEnvPair = (value) => {
	const idx = value.indexOf('=');
	if (idx === -1) {
		throw new InvalidArgumentError('Expected --env KEY=value');
	}
	return [value.slice(0, idx), value.slice(idx + 1)];
};

const queueAppInstall = async (name, opts) => {
	const env = {};
	if (opts.envJson) {
		let parsed;
		try {
			parsed = JSON.parse(opts.envJson);
		} catch {
			console.error('Invalid JSON for --env-json.');
			process.exitCode = 1;
			return;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			console.error('--env-json must be a JSON object.');
			process.exitCode = 1;
			return;
		}
		Object.assign(env, parsed);
	}
	for (const pair of opts.env || []) {
		const [key, val] = pair;
		env[key] = val;
	}

	let templates;
	try {
		templates = await fetchTemplates();
	} catch (err) {
		console.error(err.message || err);
		process.exitCode = 1;
		return;
	}
	const template = templates.find((t) => { return t.name === name; });
	if (!template) {
		console.error(`Unknown app template "${name}". Run \`virgo apps explore\` for valid names.`);
		process.exitCode = 1;
		return;
	}
	const missing = getMissingEnvKeys(template, env);
	if (missing.length > 0) {
		console.error(`Missing environment variables for "${name}": ${missing.join(', ')}`);
		process.exitCode = 1;
		return;
	}

	await enqueueDockerJob(
		'app:install',
		{
			config: {
				name,
				env
			},
			username: process.env.USER || 'cli'
		},
		`Install of "${name}" started.`
	);
};

const register = (program) => {
	const envJsonHelpExample = JSON.stringify({
		DOMAIN: getHostFqdn(),
		CERTRESOLVER: 'le'
	});

	const appsCmd = program
		.command('apps')
		.description('Installable applications');

	appsCmd
		.command('explore')
		.description('List apps you can still install (skips ones that are already installed)')
		.option('--json', 'Output as JSON')
		.action(exploreApps);

	appsCmd
		.command('install <name>')
		.description('Install an app from a template. Every variable defined for that template must be set via --env or --env-json (empty values: --env KEY=).')
		.option('--env-json <json>', `Environment variables as a JSON object, e.g. ${envJsonHelpExample}`)
		.option('--env <pair>', 'Environment variable as KEY=value (repeatable)', (value, previous) => {
			const pairs = previous ?? [];
			pairs.push(parseEnvPair(value));
			return pairs;
		}, [])
		.action(queueAppInstall);
};

module.exports = register;
