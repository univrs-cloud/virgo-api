import path from 'path';
import { lstat, readdir, realpath } from 'fs/promises';
import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';

const DATASET = 'messier/apps/nextcloud';
const MOUNTPOINT = '/messier/apps/nextcloud';
const DATA_ROOT = '/data';
const USER_FILES = 'files';
const GROUP_FOLDERS = '__groupfolders';
const SYSTEM_FOLDERS = ['files_external'];
const SYSTEM_FOLDER_PREFIX = 'appdata_';
const STAT_CONCURRENCY = 64;
const STATES = ['deleted', 'modified', 'renamed', 'moved'];
const CHANGES_LIMIT = 500;

const isUserFolder = (name) => {
	return name !== GROUP_FOLDERS && !name.startsWith(SYSTEM_FOLDER_PREFIX) && !SYSTEM_FOLDERS.includes(name);
};

const isBrowsable = (relPath) => {
	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(DATA_ROOT.length + 1).split('/');
	return isUserFolder(top) && sub === USER_FILES;
};

const byName = (a, b) => {
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
};

const resolveSnapshot = async (snapshot) => {
	if (typeof snapshot !== 'string' || !snapshot || snapshot.includes('/') || snapshot.includes('\0') || ['.', '..'].includes(snapshot)) {
		throw new Error('Invalid snapshot.');
	}

	try {
		return await realpath(`${MOUNTPOINT}/.zfs/snapshot/${snapshot}`);
	} catch (error) {
		throw new Error('The snapshot no longer exists.');
	}
};

const resolveFolder = async (root, relPath) => {
	if (typeof relPath !== 'string' || relPath.includes('\0') || path.posix.normalize(relPath) !== relPath || relPath.endsWith('/') || !isBrowsable(relPath)) {
		throw new Error('Invalid folder.');
	}

	let folder;
	let stats;
	try {
		folder = await realpath(`${root}${relPath}`);
		stats = await lstat(folder);
	} catch (error) {
		throw new Error('The folder is not in that snapshot.');
	}

	if (folder !== `${root}${relPath}` || !stats.isDirectory()) {
		throw new Error('Invalid folder.');
	}

	return folder;
};

const changedSince = async (snapshot, relPath, options) => {
	let stdout;
	try {
		({ stdout } = await execa('virgo', ['indexer', 'since', '--json', '--dataset', DATASET, '--path', relPath, ...options, '--', snapshot]));
	} catch (error) {
		throw new Error(error.stderr?.trim() || error.shortMessage || error.message);
	}

	return camelcaseKeys(JSON.parse(stdout || 'null') || { indexed: false }, { deep: true });
};

const summarize = async (snapshot, relPath) => {
	try {
		return await changedSince(snapshot, relPath, ['--summary']);
	} catch (error) {
		return { indexed: false };
	}
};

const listUsers = async (root) => {
	let entries;
	try {
		entries = await readdir(`${root}${DATA_ROOT}`, { withFileTypes: true });
	} catch (error) {
		return [];
	}

	const users = [];
	for (const entry of entries) {
		const relPath = `${DATA_ROOT}/${entry.name}/${USER_FILES}`;
		if (!entry.isDirectory() || !isBrowsable(relPath)) {
			continue;
		}

		try {
			await resolveFolder(root, relPath);
			users.push({ name: entry.name, path: relPath, states: [], currentPath: null, changesInside: 0, changeGroups: [] });
		} catch (error) {
			continue;
		}
	}
	return users.sort(byName);
};

const describeFiles = async (folder, relPath, names) => {
	const files = [];
	for (let index = 0; index < names.length; index += STAT_CONCURRENCY) {
		const batch = names.slice(index, index + STAT_CONCURRENCY);
		const described = await Promise.all(batch.map(async (name) => {
			const stats = await lstat(path.join(folder, name)).catch(() => { return null; });
			if (!stats) {
				return null;
			}

			return { name, path: `${relPath}/${name}`, size: stats.size, modifiedAt: stats.mtime.toISOString() };
		}));
		files.push(...described.filter(Boolean));
	}
	return files;
};

const browse = async (config = {}) => {
	const root = await resolveSnapshot(config.snapshot);
	if (!config.path) {
		return { status: 'succeeded', isIndexed: true, isDeleted: false, movedTo: null, folders: await listUsers(root), files: [] };
	}

	const folder = await resolveFolder(root, config.path);
	const [entries, summary] = await Promise.all([
		readdir(folder, { withFileTypes: true }),
		summarize(config.snapshot, config.path)
	]);
	const changed = new Map((summary.entries || []).map((entry) => { return [entry.name, entry]; }));
	const unlisted = (summary.deleted === true ? ['deleted'] : []);
	const folders = entries
		.filter((entry) => { return entry.isDirectory(); })
		.map((entry) => {
			const change = changed.get(entry.name);
			return { name: entry.name, path: `${config.path}/${entry.name}`, states: change?.states || unlisted, currentPath: change?.currentPath || null, changesInside: change?.inside || 0, changeGroups: change?.insideGroups || [] };
		})
		.sort(byName);
	const names = entries.filter((entry) => { return entry.isFile(); }).map((entry) => { return entry.name; });
	const files = (await describeFiles(folder, config.path, names))
		.map((file) => {
			const change = changed.get(file.name);
			return { ...file, states: change?.states || unlisted, currentPath: change?.currentPath || null };
		})
		.sort(byName);
	return { status: 'succeeded', isIndexed: summary.indexed === true, isDeleted: summary.deleted === true, movedTo: summary.movedTo || null, folders, files };
};

const describeChange = async (root, folder, change) => {
	if (typeof change.path !== 'string' || path.posix.normalize(change.path) !== change.path || !change.path.startsWith(`${folder}/`)) {
		return null;
	}

	const stats = await lstat(`${root}${change.path}`).catch(() => { return null; });
	if (!stats || (!stats.isFile() && !stats.isDirectory())) {
		return null;
	}

	return {
		name: path.posix.basename(change.path),
		path: change.path,
		isDir: stats.isDirectory(),
		size: stats.size,
		modifiedAt: stats.mtime.toISOString(),
		states: change.states,
		currentPath: change.currentPath || null
	};
};

const changes = async (config = {}) => {
	const root = await resolveSnapshot(config.snapshot);
	await resolveFolder(root, config.path);

	const states = (Array.isArray(config.states) ? config.states.map((state) => { return String(state).toLowerCase(); }) : []);
	if (!states.length || states.some((state) => { return !STATES.includes(state); })) {
		throw new Error('Invalid states.');
	}

	const offset = config.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error('Invalid offset.');
	}

	const result = await changedSince(config.snapshot, config.path, ['--state', states.join(','), '--limit', String(CHANGES_LIMIT), '--offset', String(offset)]);
	if (result.indexed !== true) {
		throw new Error('This restore point is not indexed yet.');
	}

	const items = [];
	for (let index = 0; index < result.files.length; index += STAT_CONCURRENCY) {
		const batch = result.files.slice(index, index + STAT_CONCURRENCY);
		const described = await Promise.all(batch.map((change) => { return describeChange(root, config.path, change); }));
		items.push(...described.filter(Boolean));
	}
	return { status: 'succeeded', total: result.total, hasMore: offset + result.files.length < result.total, items };
};

export default {
	name: 'browse',
	commands: {
		'indexer:browse': { handler: browse },
		'indexer:browse:changes': { handler: changes }
	}
};
