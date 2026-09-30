import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';

const TYPES = ['file', 'dir', 'link'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const cleanText = (value) => {
	if (typeof value !== 'string') {
		return null;
	}

	const text = value.trim();
	if (!text || /[\0\n\r]/.test(text)) {
		return null;
	}

	return text;
};

const isSet = (value) => {
	return value !== undefined && value !== null && value !== '';
};

const isCount = (value) => {
	return Number.isInteger(value) && value >= 0;
};

const isDate = (value) => {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
};

const search = async (config = {}, socket, module) => {
	const term = cleanText(config.term);
	if (!term) {
		throw new Error('Invalid search term.');
	}

	const dataset = cleanText(config.dataset);
	if (!dataset || !(module.getState('datasets') ?? []).includes(dataset)) {
		throw new Error('Dataset is not indexed.');
	}

	const limit = (isSet(config.limit) ? config.limit : DEFAULT_LIMIT);
	if (!isCount(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new Error('Invalid limit.');
	}

	const offset = (isSet(config.offset) ? config.offset : 0);
	if (!isCount(offset)) {
		throw new Error('Invalid offset.');
	}

	const args = ['indexer', 'search', '--json', '--dataset', dataset, '--limit', String(limit), '--offset', String(offset)];

	if (isSet(config.type)) {
		const type = cleanText(config.type)?.toLowerCase();
		if (!TYPES.includes(type)) {
			throw new Error('Invalid type.');
		}
		args.push('--type', type);
	}

	for (const [key, flag] of [['since', '--since'], ['until', '--until']]) {
		if (isSet(config[key])) {
			if (!isDate(config[key])) {
				throw new Error(`Invalid ${key} date.`);
			}
			args.push(flag, config[key]);
		}
	}

	for (const [key, flag] of [['minSize', '--min-size'], ['maxSize', '--max-size']]) {
		if (isSet(config[key])) {
			if (!isCount(config[key])) {
				throw new Error(`Invalid ${key}.`);
			}
			args.push(flag, String(config[key]));
		}
	}

	args.push('--', term);

	let stdout;
	try {
		({ stdout } = await execa('virgo', args));
	} catch (error) {
		throw new Error(error.stderr?.trim() || error.shortMessage || error.message);
	}

	const results = camelcaseKeys(JSON.parse(stdout || '[]'), { deep: true });
	return { status: 'succeeded', results, hasMore: results.length === limit };
};

export default {
	name: 'search',
	commands: {
		'indexer:search': { handler: search }
	}
};
