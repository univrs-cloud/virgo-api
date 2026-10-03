import path from 'path';
import { randomBytes } from 'crypto';
import { constants } from 'fs';
import { copyFile, lchown, lstat, lutimes, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'fs/promises';

const MOUNTPOINT = '/messier/apps/nextcloud';
const DATA_ROOT = '/data';
const USER_FILES = 'files';
const USER_TRASH = 'files_trashbin';
const GROUP_FOLDERS = '__groupfolders';
const SYSTEM_FOLDERS = ['files_external'];
const SYSTEM_FOLDER_PREFIX = 'appdata_';
const TRASHED_NAME_PATTERN = /\.d\d+$/;
const SNAPSHOT_PATH_PATTERN = new RegExp(`^${MOUNTPOINT}/\\.zfs/snapshot/([^/]+)(/.+)$`);
const CONFLICTS = ['copy', 'overwrite'];
const MAX_NAME_BYTES = 255;

const isUserFolder = (name) => {
	return name !== GROUP_FOLDERS && !name.startsWith(SYSTEM_FOLDER_PREFIX) && !SYSTEM_FOLDERS.includes(name);
};

const isRestorableFile = (relPath) => {
	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub, ...rest] = relPath.slice(DATA_ROOT.length + 1).split('/');
	if (top === GROUP_FOLDERS) {
		return sub !== undefined;
	}
	return isUserFolder(top) && [USER_FILES, USER_TRASH].includes(sub) && rest.length > 0;
};

const isRestoreDestination = (relPath) => {
	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(DATA_ROOT.length + 1).split('/');
	return isUserFolder(top) && sub === USER_FILES;
};

const restoredName = (relPath) => {
	const segments = relPath.split('/');
	const name = segments[segments.length - 1];
	const isTrashedItem = (segments.length === 6 && segments[3] === USER_TRASH && segments[4] === USER_FILES);
	return (isTrashedItem ? name.replace(TRASHED_NAME_PATTERN, '') : name);
};

const resolveSource = async (snapshotPath) => {
	if (typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath) || !SNAPSHOT_PATH_PATTERN.test(path.resolve(snapshotPath))) {
		throw new Error('Invalid file.');
	}

	let file;
	let stats;
	try {
		file = await realpath(path.resolve(snapshotPath));
		stats = await stat(file);
	} catch (error) {
		throw new Error('The file is no longer in that snapshot.');
	}

	const [, snapshot, relPath] = SNAPSHOT_PATH_PATTERN.exec(file) ?? [];
	if (!relPath || !stats.isFile() || !isRestorableFile(relPath)) {
		throw new Error('Invalid file.');
	}

	return { file, snapshot, relPath, stats };
};

const findFolder = async (relPath) => {
	let folder;
	let root;
	let stats;
	try {
		root = await realpath(MOUNTPOINT);
		folder = await realpath(`${MOUNTPOINT}${relPath}`);
		stats = await stat(folder);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw new Error('Invalid folder.');
	}

	if (folder !== `${root}${relPath}` || !stats.isDirectory()) {
		throw new Error('Invalid folder.');
	}

	return { folder, stats };
};

const resolveDestination = async (relPath) => {
	if (typeof relPath !== 'string' || relPath.includes('\0') || path.posix.normalize(relPath) !== relPath || relPath.endsWith('/') || !isRestoreDestination(relPath)) {
		throw new Error('Invalid folder.');
	}

	const missing = [];
	let current = relPath;
	let existing = await findFolder(current);
	while (!existing) {
		const name = path.posix.basename(current);
		current = path.posix.dirname(current);
		if (!isRestoreDestination(current)) {
			throw new Error('The folder no longer exists.');
		}
		if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
			throw new Error('Invalid folder.');
		}

		missing.unshift(name);
		existing = await findFolder(current);
	}

	return { ...existing, missing };
};

const resolveExistingDestination = async (relPath) => {
	const destination = await resolveDestination(relPath);
	if (destination.missing.length) {
		throw new Error('The folder no longer exists.');
	}

	return destination;
};

const createFolder = async (parent, name, stats, created) => {
	const folder = path.join(parent, name);
	try {
		await mkdir(folder, { mode: stats.mode & 0o7777 });
		created.push(folder);
		await lchown(folder, stats.uid, stats.gid);
	} catch (error) {
		if (error.code !== 'EEXIST') {
			throw error;
		}
	}

	if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) {
		throw new Error('The folder changed while restoring.');
	}

	return folder;
};

const findExisting = async (folder, name) => {
	try {
		return await lstat(path.join(folder, name));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
};

const describe = (stats) => {
	return { size: stats.size, modifiedAt: stats.mtime.toISOString() };
};

const byName = (a, b) => {
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
};

const listRoots = async () => {
	let entries;
	try {
		entries = await readdir(`${MOUNTPOINT}${DATA_ROOT}`, { withFileTypes: true });
	} catch (error) {
		return [];
	}

	const roots = [];
	for (const entry of entries) {
		const relPath = `${DATA_ROOT}/${entry.name}/${USER_FILES}`;
		if (!entry.isDirectory() || !isRestoreDestination(relPath)) {
			continue;
		}

		try {
			await resolveExistingDestination(relPath);
			roots.push({ name: entry.name, path: relPath });
		} catch (error) {
			continue;
		}
	}
	return roots.sort(byName);
};

const listFolders = async (config = {}) => {
	if (!config.path) {
		return { status: 'succeeded', folders: await listRoots() };
	}

	const { folder } = await resolveExistingDestination(config.path);
	const entries = await readdir(folder, { withFileTypes: true });
	const folders = entries
		.filter((entry) => { return entry.isDirectory(); })
		.map((entry) => { return { name: entry.name, path: `${config.path}/${entry.name}` }; })
		.sort(byName);
	return { status: 'succeeded', folders };
};

const inspect = async (config = {}) => {
	const source = await resolveSource(config.snapshotPath);
	const destination = await resolveDestination(config.destination);
	const name = restoredName(source.relPath);
	const existing = (destination.missing.length ? null : await findExisting(destination.folder, name));
	if (existing && !existing.isFile()) {
		throw new Error(`${name} already exists in that folder and is not a file.`);
	}

	return { status: 'succeeded', name, source: describe(source.stats), existing: (existing ? describe(existing) : null) };
};

const snapshotDate = (snapshot) => {
	const [, day, time] = snapshot.split('_');
	const date = new Date(`${day}T${time}Z`);
	if (Number.isNaN(date.getTime())) {
		return snapshot;
	}

	return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const copyName = async (folder, name, snapshot) => {
	const extension = path.extname(name);
	const label = `${path.basename(name, extension)} (restored ${snapshotDate(snapshot)})`;
	for (let attempt = 1; ; attempt++) {
		const candidate = `${label}${attempt > 1 ? ` ${attempt}` : ''}${extension}`;
		if (!await findExisting(folder, candidate)) {
			return candidate;
		}
	}
};

const escapeHtml = (text) => {
	return String(text).replace(/[&<>"']/g, (character) => { return `&#${character.charCodeAt(0)};`; });
};

const restoreFile = async (job, module) => {
	const { config = {} } = job.data;
	const source = await resolveSource(config.snapshotPath);
	const destination = await resolveDestination(config.destination);
	const name = restoredName(source.relPath);
	const conflict = String(config.conflict ?? '').toLowerCase();
	const existing = (destination.missing.length ? null : await findExisting(destination.folder, name));
	if (existing && !existing.isFile()) {
		throw new Error(`${name} already exists in that folder and is not a file.`);
	}
	if (existing && !CONFLICTS.includes(conflict)) {
		throw new Error(`${name} already exists in that folder.`);
	}

	const targetName = (existing && conflict === 'copy' ? await copyName(destination.folder, name, source.snapshot) : name);
	await module.updateJobProgress(job, `Restoring ${escapeHtml(targetName)}...`);
	const created = [];
	let partial = null;
	try {
		let folder = destination.folder;
		for (const missing of destination.missing) {
			folder = await createFolder(folder, missing, destination.stats, created);
		}

		partial = path.join(folder, `.restoring-${randomBytes(8).toString('hex')}`);
		await copyFile(source.file, partial, constants.COPYFILE_EXCL);
		if (await realpath(partial) !== partial) {
			throw new Error('The folder changed while restoring.');
		}
		await lchown(partial, destination.stats.uid, destination.stats.gid);
		await lutimes(partial, source.stats.atime, source.stats.mtime);
		await rename(partial, path.join(folder, targetName));
	} catch (error) {
		if (partial) {
			await rm(partial, { force: true });
		}
		for (const folder of created.reverse()) {
			await rmdir(folder).catch(() => {});
		}
		throw error;
	}

	return `${escapeHtml(targetName)} restored to ${escapeHtml(config.destination.slice(DATA_ROOT.length + 1))}.`;
};

const restore = async (job, module) => {
	try {
		return await restoreFile(job, module);
	} catch (error) {
		throw new Error(escapeHtml(error.message));
	}
};

export default {
	name: 'restore',
	commands: {
		'indexer:restore:folders': { handler: listFolders },
		'indexer:restore:inspect': { handler: inspect },
		'indexer:restore': { job: 'indexer:restore' }
	},
	jobs: {
		'indexer:restore': restore
	}
};
