import fs from 'fs/promises';
import { createLog } from './log.js';

const log = createLog('sanoid');

const CONF_FILE = '/etc/sanoid/sanoid.conf';
const TEMPLATE_PREFIX = 'template_';
const MODES = ['enabled', 'paused', 'disabled'];
const MODE_TEMPLATES = { paused: 'paused', disabled: 'ignore' };
const TEMPLATES = {
	paused: { autosnap: 'no', autoprune: 'no' },
	ignore: { frequently: '0', hourly: '0', daily: '0', weekly: '0', monthly: '0', yearly: '0', autosnap: 'no', autoprune: 'yes' }
};
const RESERVED_TEMPLATES = ['default', 'paused', 'ignore', 'backup'];
const DEFAULTS = { autosnap: 'yes', autoprune: 'yes', frequently: '0', hourly: '48', daily: '90', weekly: '0', monthly: '6', yearly: '0' };
const RETENTION_KEYS = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
const RULE_KEYS = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'autosnap', 'autoprune', 'pre_snapshot_script', 'no_inconsistent_snapshot'];
const MAX_RETENTION = 9999;
const UNIT_HOURS = { hours: 1, days: 24, weeks: 168, months: 730.5, years: 8766 };
const KIND_HOURS = { frequently: 0.25, hourly: 1, daily: 24, weekly: 168, monthly: 730.5, yearly: 8766 };
const MAX_SPANS = {
	frequently: { hours: 48, text: '15-minute snapshots can be kept for at most 2 days.' },
	hourly: { hours: 336, text: 'Hourly snapshots can be kept for at most 2 weeks.' },
	daily: { hours: 2191.5, text: 'Daily snapshots can be kept for at most 3 months.' },
	weekly: { hours: 4383, text: 'Weekly snapshots can be kept for at most 6 months.' },
	monthly: { hours: 43830, text: 'Monthly snapshots can be kept for at most 5 years.' },
	yearly: { hours: 87660, text: 'Yearly snapshots can be kept for at most 10 years.' }
};
const KIND_UNITS = {
	frequently: ['hours', 'days'],
	hourly: ['hours', 'days', 'weeks'],
	daily: ['days', 'weeks', 'months'],
	weekly: ['weeks', 'months'],
	monthly: ['months', 'years'],
	yearly: ['years']
};
const RULE_NAME_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,39}$/i;
const SCHEDULE_SCRIPT = '/usr/local/bin/virgo-snapshot-schedule';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const HOURS = Array.from({ length: 24 }, (value, hour) => { return hour; });
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

const isReserved = (name) => {
	return RESERVED_TEMPLATES.includes(String(name).toLowerCase());
};

const templatesOf = (section) => {
	return String(section.values.use_template ?? '').split(',').map((name) => { return name.trim(); }).filter(Boolean);
};

const ruleNameOf = (sections, section) => {
	const name = templatesOf(section).filter((template) => { return !isReserved(template); }).at(-1);
	if (!name) {
		return null;
	}

	return (findSection(sections, `${TEMPLATE_PREFIX}${name}`)?.name.slice(TEMPLATE_PREFIX.length) ?? name);
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
		const lines = Object.entries(section.values).map(([key, value]) => { return (value === '' ? `\t${key} =` : `\t${key} = ${value}`); });
		return [`[${section.name}]`, ...lines].join('\n');
	};
	return `${[datasets.map(render).join('\n'), templates.map(render).join('\n\n')].filter(Boolean).join('\n\n')}\n`;
};

const resolveSection = (sections, section, inherited) => {
	const config = { ...(inherited ?? { ...DEFAULTS, ...findSection(sections, `${TEMPLATE_PREFIX}default`)?.values }) };
	for (const name of templatesOf(section)) {
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
	let rule = null;
	for (let depth = 1; depth <= parts.length; depth++) {
		const name = parts.slice(0, depth).join('/');
		const section = findSection(sections, name);
		if (section && (depth === parts.length || isRecursive(section))) {
			config = resolveSection(sections, section, config);
			rule = (ruleNameOf(sections, section) ?? rule);
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
	return { mode, retention, rule: (mode === 'disabled' ? null : rule) };
};

const windowHours = (from, to) => {
	return HOURS.filter((hour) => { return hour >= from && hour < to; });
};

const hourRuns = (hours) => {
	const runs = [];
	for (const hour of hours) {
		const last = runs.at(-1);
		if (last && hour === last[1] + 1) {
			last[1] = hour;
		} else {
			runs.push([hour, hour]);
		}
	}
	return runs;
};

const hourWindow = (hours) => {
	const runs = hourRuns(hours);
	if (!runs.length) {
		return { from: 0, to: 24 };
	}

	return { from: runs[0][0], to: runs.at(-1)[1] + 1 };
};

const parseSchedule = (script) => {
	const words = String(script ?? '').trim().split(/\s+/);
	const schedule = { days: [...WEEKDAYS], from: 0, to: 24, keep: {} };
	if (words[0].toLowerCase() !== SCHEDULE_SCRIPT.toLowerCase()) {
		return schedule;
	}

	for (const word of words.slice(1)) {
		const [key, value = ''] = word.toLowerCase().split('=');
		const [prefix, kind] = key.split('.');
		const span = /^(\d+)([a-z]+)$/.exec(value);
		if (prefix === 'keep' && Object.hasOwn(KIND_UNITS, kind) && span && KIND_UNITS[kind].includes(span[2])) {
			schedule.keep[kind] = { amount: Number(span[1]), unit: span[2] };
		}
		if (key === 'days') {
			schedule.days = (value === 'none' ? [] : WEEKDAYS.filter((day) => { return value.split(',').includes(day); }));
		}
		if (key === 'hours') {
			Object.assign(schedule, hourWindow(HOURS.filter((hour) => {
				return value.split(',').some((range) => {
					const [start, end = start] = range.split('-').map(Number);
					return (hour >= start && hour <= end);
				});
			})));
		}
	}
	return schedule;
};

const scheduleScript = ({ days, from, to }, keep) => {
	const words = [];
	if (days.length !== WEEKDAYS.length) {
		words.push(`days=${(days.length ? days.join(',') : 'none')}`);
	}
	const hours = windowHours(from, to);
	if (hours.length !== HOURS.length) {
		words.push(`hours=${hourRuns(hours).map(([start, end]) => { return (start === end ? `${start}` : `${start}-${end}`); }).join(',')}`);
	}
	if (!words.length) {
		return '';
	}

	for (const kind of RETENTION_KEYS) {
		if (keep[kind].amount > 0) {
			words.push(`keep.${kind}=${keep[kind].amount}${keep[kind].unit}`);
		}
	}
	return [SCHEDULE_SCRIPT, ...words].join(' ');
};

const shareOf = (kind, { days, from, to }) => {
	if (kind === 'daily') {
		return days.length / WEEKDAYS.length;
	}

	if (kind === 'frequently' || kind === 'hourly') {
		return (days.length / WEEKDAYS.length) * ((to - from) / HOURS.length);
	}

	return 1;
};

const countOf = (kind, { amount, unit }, schedule) => {
	const share = shareOf(kind, schedule);
	if (amount === 0 || share === 0) {
		return 0;
	}

	return Math.max(1, Math.ceil((amount * UNIT_HOURS[unit] / KIND_HOURS[kind] * share) - 1e-9));
};

const spanOf = (kind, count, schedule) => {
	const share = shareOf(kind, schedule);
	if (count === 0 || share === 0) {
		return { amount: 0, unit: KIND_UNITS[kind][0] };
	}

	const hours = count * KIND_HOURS[kind] / share;
	const unit = [...KIND_UNITS[kind]].reverse().find((current) => {
		const amount = hours / UNIT_HOURS[current];
		return Math.abs(amount - Math.round(amount)) < 1e-6 && Math.round(amount) > 0;
	}) ?? KIND_UNITS[kind][0];
	return { amount: Math.max(1, Math.round(hours / UNIT_HOURS[unit])), unit };
};

const usageOf = (sections, name) => {
	const users = sections.filter((section) => {
		return !isTemplate(section) && templatesOf(section).some((template) => { return template.toLowerCase() === name.toLowerCase(); });
	});
	return {
		isUsed: users.length > 0,
		isDefault: users.some(isRecursive)
	};
};

const ruleOf = (sections, section) => {
	const name = section.name.slice(TEMPLATE_PREFIX.length);
	const values = { ...DEFAULTS, ...findSection(sections, `${TEMPLATE_PREFIX}default`)?.values, ...section.values };
	const retention = {};
	for (const key of RETENTION_KEYS) {
		retention[key] = Number.parseInt(values[key], 10) || 0;
	}
	const { keep: storedKeep, ...schedule } = parseSchedule(values.pre_snapshot_script);
	const keep = Object.fromEntries(RETENTION_KEYS.map((kind) => {
		return [kind, (retention[kind] > 0 ? (storedKeep[kind] ?? spanOf(kind, retention[kind], schedule)) : { amount: 0, unit: KIND_UNITS[kind][0] })];
	}));
	return { name, retention, keep, schedule, ...usageOf(sections, name) };
};

const normalizeRule = (rule) => {
	const name = String(rule?.name ?? '').trim();
	if (!RULE_NAME_PATTERN.test(name)) {
		throw new Error('A rule name can use letters, numbers, spaces, dashes and underscores, up to 40 characters.');
	}

	if (isReserved(name)) {
		throw new Error(`The name "${name}" is used by the system, choose another one.`);
	}

	const days = rule?.schedule?.days;
	const from = Number(rule?.schedule?.from);
	const to = Number(rule?.schedule?.to);
	if (!Array.isArray(days) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 24 || from >= to) {
		throw new Error('The snapshot days and hours are not valid, check them and save again.');
	}

	const schedule = { days: WEEKDAYS.filter((day) => { return days.includes(day); }), from, to };
	const keep = {};
	const values = {};
	for (const kind of RETENTION_KEYS) {
		const amount = Number(rule?.keep?.[kind]?.amount ?? 0);
		const unit = String(rule?.keep?.[kind]?.unit ?? '').toLowerCase();
		if (!Number.isInteger(amount) || amount < 0 || !KIND_UNITS[kind].includes(unit)) {
			throw new Error('How long snapshots are kept is not valid, check it and save again.');
		}

		if (amount * UNIT_HOURS[unit] > MAX_SPANS[kind].hours + 1e-9) {
			throw new Error(MAX_SPANS[kind].text);
		}

		const count = countOf(kind, { amount, unit }, schedule);
		if (count > MAX_RETENTION) {
			throw new Error('Snapshots would be kept for too long, choose a shorter time.');
		}

		keep[kind] = { amount, unit };
		values[kind] = String(count);
	}
	if (RETENTION_KEYS.every((key) => { return values[key] === '0'; })) {
		throw new Error('Keep at least one kind of snapshot.');
	}

	const script = scheduleScript(schedule, keep);
	Object.assign(values, { autosnap: 'yes', autoprune: 'yes', pre_snapshot_script: script, no_inconsistent_snapshot: (script ? 'yes' : 'no') });
	return { name, values: Object.fromEntries(RULE_KEYS.map((key) => { return [key, values[key]]; })) };
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

const writeIfChanged = async (sections, next) => {
	if (stringify(next) !== stringify(sections)) {
		await write(next);
	}
};

const getRules = async () => {
	await queue;
	const sections = await read();
	return sections
		.filter((section) => { return isTemplate(section) && !isReserved(section.name.slice(TEMPLATE_PREFIX.length)); })
		.map((section) => { return ruleOf(sections, section); })
		.sort((first, second) => { return first.name.localeCompare(second.name); });
};

const saveRule = (previousName, rule) => {
	return serialize(async () => {
		const { name, values } = normalizeRule(rule);
		const sections = await read();
		const previous = (previousName ? findSection(sections, `${TEMPLATE_PREFIX}${previousName}`) : null);
		if (previousName && (!previous || isReserved(previousName))) {
			throw new Error(`The rule "${previousName}" no longer exists.`);
		}

		if (previous && usageOf(sections, previousName).isDefault) {
			throw new Error(`The rule "${previousName}" is the default rule and cannot be changed.`);
		}

		const existing = findSection(sections, `${TEMPLATE_PREFIX}${name}`);
		if (existing && existing !== previous) {
			throw new Error(`A rule named "${name}" already exists, choose another name.`);
		}

		const template = { name: `${TEMPLATE_PREFIX}${name}`, values };
		if (!previous) {
			await writeIfChanged(sections, [...sections, template]);
			return;
		}

		const previousRule = previous.name.slice(TEMPLATE_PREFIX.length).toLowerCase();
		const next = sections.map((section) => {
			if (section === previous) {
				return template;
			}

			const templates = templatesOf(section);
			if (isTemplate(section) || !templates.some((current) => { return current.toLowerCase() === previousRule; })) {
				return section;
			}

			return { name: section.name, values: { ...section.values, use_template: templates.map((current) => { return (current.toLowerCase() === previousRule ? name : current); }).join(',') } };
		});
		await writeIfChanged(sections, next);
	});
};

const deleteRule = (name) => {
	return serialize(async () => {
		const sections = await read();
		const section = findSection(sections, `${TEMPLATE_PREFIX}${name}`);
		if (!section || isReserved(name)) {
			throw new Error(`The rule "${name}" no longer exists.`);
		}

		const { isUsed, isDefault } = usageOf(sections, name);
		if (isDefault) {
			throw new Error(`The rule "${name}" is the default rule and cannot be deleted.`);
		}

		if (isUsed) {
			throw new Error(`The rule "${name}" is still used. Choose another rule for its apps and folders first.`);
		}

		await write(sections.filter((current) => { return current !== section; }));
	});
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
		log.error(`Could not read ${CONF_FILE}:`, error);
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
		const section = findSection(sections, dataset);
		const rule = (section ? ruleNameOf(sections, section) : null);
		const template = MODE_TEMPLATES[mode];
		const templates = (mode === 'disabled' ? [template] : [rule, template].filter(Boolean));
		const next = sections
			.filter((current) => { return current !== section; })
			.map((current) => {
				const name = current.name.toLowerCase().slice(TEMPLATE_PREFIX.length);
				return (isTemplate(current) && Object.hasOwn(TEMPLATES, name) ? { name: current.name, values: { ...TEMPLATES[name] } } : current);
			});
		if (template && !findSection(next, `${TEMPLATE_PREFIX}${template}`)) {
			next.push({ name: `${TEMPLATE_PREFIX}${template}`, values: { ...TEMPLATES[template] } });
		}
		if (templates.length) {
			next.push({ name: dataset, values: { use_template: templates.join(',') } });
		}
		if (policyOf(next, dataset)?.mode !== mode) {
			throw new Error(`Snapshots of ${dataset} cannot be ${mode}.`);
		}

		await writeIfChanged(sections, next);
	});
};

const setRule = (dataset, rule) => {
	return serialize(async () => {
		const sections = await read();
		const template = findSection(sections, `${TEMPLATE_PREFIX}${rule}`);
		if (!template || isReserved(rule)) {
			throw new Error(`The rule "${rule}" no longer exists.`);
		}

		const section = findSection(sections, dataset);
		if (policyOf(sections, dataset)?.mode === 'disabled') {
			throw new Error('Snapshots are disabled. Enable them before choosing a rule.');
		}

		const templates = (section ? templatesOf(section) : []);
		const paused = templates.filter((current) => { return current.toLowerCase() === MODE_TEMPLATES.paused; });
		const next = sections.filter((current) => { return current !== section; });
		next.push({ name: dataset, values: { ...section?.values, use_template: [template.name.slice(TEMPLATE_PREFIX.length), ...paused].join(',') } });
		await writeIfChanged(sections, next);
	});
};

const setValues = (dataset, values) => {
	return serialize(async () => {
		const sections = await read();
		const section = findSection(sections, dataset);
		if (!section) {
			throw new Error(`${dataset} has no section in ${CONF_FILE}.`);
		}

		const next = sections.map((current) => {
			return (current === section ? { name: current.name, values: { ...current.values, ...values } } : current);
		});
		await writeIfChanged(sections, next);
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

export { MODES, getPolicies, getRules, saveRule, deleteRule, setMode, setRule, setValues, removeSection };
