import fs from 'fs/promises';

const CONF_FILE = '/etc/sanoid/sanoid.conf';
const TEMPLATE_PREFIX = 'template_';
const MODES = ['enabled', 'paused', 'disabled'];
const MODE_TEMPLATES = { paused: 'paused', disabled: 'ignore' };
const TEMPLATES = {
	paused: { autosnap: 'no', autoprune: 'no' },
	ignore: { frequently: '0', hourly: '0', daily: '0', monthly: '0', yearly: '0', autosnap: 'no', autoprune: 'yes' }
};
const DEFAULTS = { autosnap: 'yes', autoprune: 'yes', frequently: '0', hourly: '48', daily: '90', weekly: '0', monthly: '6', yearly: '0' };
const RETENTION_KEYS = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const STRUCTURAL_KEY_PATTERN = /template|recursive|skip_children/;

let queue = Promise.resolve();

const isTrue = (value) => {
	return TRUE_VALUES.includes(String(value ?? '').toLowerCase());
};

const isRecursive = (section) => {
	const value = String(section.values.recursive ?? '').toLowerCase();
	return (isTrue(value) || value.includes('zfs'));
};

const isTemplate = (section) => {
	return section.name.toLowerCase().startsWith(TEMPLATE_PREFIX);
};

const findSection = (sections, name) => {
	return sections.find((section) => { return section.name.toLowerCase() === name.toLowerCase(); });
};

const parse = (text) => {
	const sections = [];
	let current = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#') || line.startsWith(';')) {
			continue;
		}

		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			const name = header[1].trim();
			current = findSection(sections, name);
			if (!current) {
				current = { name, values: {} };
				sections.push(current);
			}
			continue;
		}

		const separator = line.indexOf('=');
		if (separator === -1 || current === null) {
			continue;
		}

		const key = line.slice(0, separator).trim();
		if (key !== '' && !Object.hasOwn(current.values, key)) {
			current.values[key] = line.slice(separator + 1).trim();
		}
	}
	return sections;
};

const stringify = (sections) => {
	const datasets = sections
		.filter((section) => { return !isTemplate(section); })
		.sort((first, second) => { return (first.name < second.name ? -1 : (first.name > second.name ? 1 : 0)); });
	const templates = sections.filter(isTemplate);
	const render = (section) => {
		const lines = Object.entries(section.values).map(([key, value]) => { return `\t${key} = ${value}`; });
		return [`[${section.name}]`, ...lines].join('\n');
	};
	return `${[datasets.map(render).join('\n'), templates.map(render).join('\n\n')].filter(Boolean).join('\n\n')}\n`;
};

const resolveSection = (sections, section, inherited) => {
	const config = { ...(inherited ?? { ...DEFAULTS, ...findSection(sections, `${TEMPLATE_PREFIX}default`)?.values }) };
	const templates = String(section.values.use_template ?? '').split(',').map((name) => { return name.trim(); }).filter(Boolean);
	for (const name of templates) {
		Object.assign(config, findSection(sections, `${TEMPLATE_PREFIX}${name}`)?.values);
	}
	Object.assign(config, section.values);
	for (const key of Object.keys(config)) {
		if (STRUCTURAL_KEY_PATTERN.test(key)) {
			delete config[key];
		}
	}
	return config;
};

const policyOf = (sections, dataset) => {
	const parts = dataset.split('/');
	let config = null;
	for (let depth = 1; depth <= parts.length; depth++) {
		const name = parts.slice(0, depth).join('/');
		const section = findSection(sections, name);
		if (section && (depth === parts.length || isRecursive(section))) {
			config = resolveSection(sections, section, config);
		}
	}
	if (config === null) {
		return null;
	}

	let mode = 'paused';
	if (isTrue(config.autosnap)) {
		mode = 'enabled';
	} else if (isTrue(config.autoprune)) {
		mode = 'disabled';
	}
	const retention = {};
	for (const key of RETENTION_KEYS) {
		retention[key] = Number.parseInt(config[key], 10) || 0;
	}
	return { mode, retention };
};

const read = async () => {
	return parse(await fs.readFile(CONF_FILE, 'utf8'));
};

const write = async (sections) => {
	const temporaryFile = `${CONF_FILE}.tmp`;
	await fs.writeFile(temporaryFile, stringify(sections), { encoding: 'utf8', mode: 0o644 });
	await fs.rename(temporaryFile, CONF_FILE);
};

const serialize = (task) => {
	const result = queue.then(task);
	queue = result.catch(() => {});
	return result;
};

const getPolicies = async (datasets) => {
	const policies = {};
	try {
		await queue;
		const sections = await read();
		for (const dataset of datasets) {
			policies[dataset] = policyOf(sections, dataset);
		}
	} catch (error) {
		console.error(`Could not read ${CONF_FILE}:`, error);
		for (const dataset of datasets) {
			policies[dataset] = null;
		}
	}
	return policies;
};

const setMode = (dataset, mode) => {
	return serialize(async () => {
		if (!MODES.includes(mode)) {
			throw new Error(`Snapshots mode must be one of: ${MODES.join(', ')}.`);
		}

		const sections = await read();
		if (policyOf(sections, dataset)?.mode === mode) {
			return;
		}

		const next = sections.filter((section) => { return section.name.toLowerCase() !== dataset.toLowerCase(); });
		const template = MODE_TEMPLATES[mode];
		if (template) {
			if (!findSection(next, `${TEMPLATE_PREFIX}${template}`)) {
				next.push({ name: `${TEMPLATE_PREFIX}${template}`, values: { ...TEMPLATES[template] } });
			}
			next.push({ name: dataset, values: { use_template: template } });
		}
		if (policyOf(next, dataset)?.mode !== mode) {
			throw new Error(`Snapshots of ${dataset} cannot be ${mode}.`);
		}

		await write(next);
	});
};

const removeSection = (dataset) => {
	return serialize(async () => {
		const sections = await read();
		const next = sections.filter((section) => {
			const name = section.name.toLowerCase();
			return name !== dataset.toLowerCase() && !name.startsWith(`${dataset.toLowerCase()}/`);
		});
		if (next.length !== sections.length) {
			await write(next);
		}
	});
};

export { MODES, getPolicies, setMode, removeSection };
