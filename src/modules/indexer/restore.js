import path from 'path';
import { randomBytes } from 'crypto';
import { constants } from 'fs';
import { copyFile, lstat, lutimes, mkdir, readdir, realpath, rename, rm, rmdir, stat, utimes } from 'fs/promises';
import { execa } from 'execa';

const MOUNTPOINT = '/messier/apps/nextcloud';
const DATA_ROOT = '/data';
const USER_FILES = 'files';
const USER_TRASH = 'files_trashbin';
const GROUP_FOLDERS = '__groupfolders';
const SYSTEM_FOLDERS = ['files_external'];
const SYSTEM_FOLDER_PREFIX = 'appdata_';
const TRASHED_NAME_PATTERN = /\.d\d+$/;
const DATASET = 'messier/apps/nextcloud';
const FOLDER_DATASET_PATTERN = /^messier\/folders\/[^/\0]+$/;
const CONFLICTS = ['copy', 'overwrite'];
const MAX_NAME_BYTES = 255;
const OWNER = 'voyager:users';
const MAX_SELECTION_PATHS = 50000;
const PROGRESS_STEP = 100;

const isUserFolder = (name) => {
	return name !== GROUP_FOLDERS && !name.startsWith(SYSTEM_FOLDER_PREFIX) && !SYSTEM_FOLDERS.includes(name);
};

const resolveTarget = (dataset) => {
	if (dataset === undefined || dataset === null || dataset === '') {
		return { dataset: DATASET, mountpoint: MOUNTPOINT, isNextcloud: true };
	}

	const name = String(dataset);
	if (!FOLDER_DATASET_PATTERN.test(name) || ['.', '..'].includes(name.split('/')[2])) {
		throw new Error('Invalid folder.');
	}

	return { dataset: name, mountpoint: `/${name}`, isNextcloud: false };
};

const snapshotPathPattern = (target) => {
	return new RegExp(`^${target.mountpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.zfs/snapshot/([^/]+)(/.+)$`);
};

const locationOf = (target, relPath) => {
	return (target.isNextcloud ? relPath.slice(DATA_ROOT.length + 1) : `${path.posix.basename(target.dataset)}${relPath}`);
};

const isRestorableFile = (target, relPath) => {
	if (!target.isNextcloud) {
		return true;
	}

	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub, ...rest] = relPath.slice(DATA_ROOT.length + 1).split('/');
	if (top === GROUP_FOLDERS) {
		return sub !== undefined;
	}
	return isUserFolder(top) && [USER_FILES, USER_TRASH].includes(sub) && rest.length > 0;
};

const isRestoreDestination = (target, relPath) => {
	if (!target.isNextcloud) {
		return (relPath === '' || relPath.startsWith('/'));
	}

	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(DATA_ROOT.length + 1).split('/');
	return isUserFolder(top) && sub === USER_FILES;
};

const restoredName = (target, relPath) => {
	const segments = relPath.split('/');
	const name = segments[segments.length - 1];
	const isTrashedItem = (target.isNextcloud && segments.length === 6 && segments[3] === USER_TRASH && segments[4] === USER_FILES);
	return (isTrashedItem ? name.replace(TRASHED_NAME_PATTERN, '') : name);
};

const resolveSource = async (target, snapshotPath) => {
	const pattern = snapshotPathPattern(target);
	if (typeof snapshotPath !== 'string' || !path.isAbsolute(snapshotPath) || !pattern.test(path.resolve(snapshotPath))) {
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

	const [, snapshot, relPath] = pattern.exec(file) ?? [];
	if (!relPath || !stats.isFile() || !isRestorableFile(target, relPath)) {
		throw new Error('Invalid file.');
	}

	return { file, snapshot, relPath, stats };
};

const findFolder = async (target, relPath) => {
	let folder;
	let root;
	let stats;
	try {
		root = await realpath(target.mountpoint);
		folder = await realpath(`${target.mountpoint}${relPath}`);
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

const resolveDestination = async (target, relPath) => {
	if (typeof relPath !== 'string' || relPath.includes('\0') || (relPath !== '' && (path.posix.normalize(relPath) !== relPath || relPath.endsWith('/'))) || !isRestoreDestination(target, relPath)) {
		throw new Error('Invalid folder.');
	}

	const missing = [];
	let current = relPath;
	let existing = await findFolder(target, current);
	while (!existing) {
		if (current === '') {
			throw new Error('The folder no longer exists.');
		}

		const name = path.posix.basename(current);
		const parent = path.posix.dirname(current);
		current = (!target.isNextcloud && parent === '/' ? '' : parent);
		if (!isRestoreDestination(target, current)) {
			throw new Error('The folder no longer exists.');
		}
		if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
			throw new Error('Invalid folder.');
		}

		missing.unshift(name);
		existing = await findFolder(target, current);
	}

	return { ...existing, missing };
};

const resolveExistingDestination = async (target, relPath) => {
	const destination = await resolveDestination(target, relPath);
	if (destination.missing.length) {
		throw new Error('The folder no longer exists.');
	}

	return destination;
};

const setOwner = async (target) => {
	await execa('chown', ['-h', '--', OWNER, target]);
};

const createFolder = async (target, parent, name, stats, created) => {
	const folder = path.join(parent, name);
	try {
		await mkdir(folder, { mode: stats.mode & 0o7777 });
		created.push(folder);
		if (target.isNextcloud) {
			await setOwner(folder);
		}
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

	const target = resolveTarget();
	const roots = [];
	for (const entry of entries) {
		const relPath = `${DATA_ROOT}/${entry.name}/${USER_FILES}`;
		if (!entry.isDirectory() || !isRestoreDestination(target, relPath)) {
			continue;
		}

		try {
			await resolveExistingDestination(target, relPath);
			roots.push({ name: entry.name, path: relPath });
		} catch (error) {
			continue;
		}
	}
	return roots.sort(byName);
};

const listFolders = async (config = {}) => {
	const target = resolveTarget(config.dataset);
	if (!config.path && target.isNextcloud) {
		return { status: 'succeeded', folders: await listRoots() };
	}

	const relPath = config.path || '';
	const { folder } = await resolveExistingDestination(target, relPath);
	const entries = await readdir(folder, { withFileTypes: true });
	const folders = entries
		.filter((entry) => { return entry.isDirectory(); })
		.map((entry) => { return { name: entry.name, path: `${relPath}/${entry.name}` }; })
		.sort(byName);
	return { status: 'succeeded', folders };
};

const inspect = async (config = {}) => {
	const target = resolveTarget(config.dataset);
	const source = await resolveSource(target, config.snapshotPath);
	const destination = await resolveDestination(target, config.destination);
	const name = restoredName(target, source.relPath);
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
	const target = resolveTarget(config.dataset);
	const source = await resolveSource(target, config.snapshotPath);
	const destination = await resolveDestination(target, config.destination);
	const name = restoredName(target, source.relPath);
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
			folder = await createFolder(target, folder, missing, destination.stats, created);
		}

		partial = path.join(folder, `.restoring-${randomBytes(8).toString('hex')}`);
		await copyFile(source.file, partial, constants.COPYFILE_EXCL);
		if (await realpath(partial) !== partial) {
			throw new Error('The folder changed while restoring.');
		}
		if (target.isNextcloud) {
			await setOwner(partial);
		}
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

	return `${escapeHtml(targetName)} restored to ${escapeHtml(locationOf(target, config.destination))}.`;
};

const isSelectable = (target, relPath) => {
	if (!target.isNextcloud) {
		return true;
	}

	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(DATA_ROOT.length + 1).split('/');
	return isUserFolder(top) && sub === USER_FILES;
};

const isCleanPath = (value) => {
	return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !value.endsWith('/') && path.posix.normalize(value) === value;
};

const isInside = (child, folder) => {
	return child.startsWith(`${folder}/`);
};

const resolveSnapshotRoot = async (target, snapshot) => {
	if (typeof snapshot !== 'string' || !snapshot || snapshot.includes('/') || snapshot.includes('\0') || ['.', '..'].includes(snapshot)) {
		throw new Error('Invalid snapshot.');
	}

	let root;
	try {
		root = await realpath(`${target.mountpoint}/.zfs/snapshot/${snapshot}`);
	} catch (error) {
		throw new Error('The snapshot no longer exists.');
	}

	if (root !== `${target.mountpoint}/.zfs/snapshot/${snapshot}`) {
		throw new Error('Invalid snapshot.');
	}

	return root;
};

const resolveSelection = async (target, root, config) => {
	const paths = (Array.isArray(config.items) ? config.items : []);
	const excluded = (Array.isArray(config.excluded) ? config.excluded : []);
	if (!paths.length || paths.length + excluded.length > MAX_SELECTION_PATHS || !paths.every(isCleanPath) || !excluded.every(isCleanPath)) {
		throw new Error('Invalid selection.');
	}

	const items = [];
	for (const relPath of [...new Set(paths)].sort()) {
		if (items.some((item) => { return item.isDir && isInside(relPath, item.path); })) {
			continue;
		}
		if (!isSelectable(target, relPath)) {
			throw new Error('Invalid selection.');
		}

		let stats;
		try {
			if (await realpath(`${root}${relPath}`) !== `${root}${relPath}`) {
				throw new Error('Invalid selection.');
			}
			stats = await lstat(`${root}${relPath}`);
		} catch (error) {
			throw new Error(`${path.posix.basename(relPath)} is no longer in that snapshot.`);
		}

		if (!stats.isFile() && !stats.isDirectory()) {
			throw new Error('Invalid selection.');
		}
		items.push({ path: relPath, isDir: stats.isDirectory() });
	}

	let common = path.posix.dirname(items[0].path);
	while (common !== '/' && !items.every((item) => { return isInside(item.path, common); })) {
		common = path.posix.dirname(common);
	}
	return { items, excluded: new Set(excluded), common: (common === '/' ? '' : common) };
};

const createRestoreFolder = async (parent, snapshot, stats) => {
	const label = `Restore (${snapshotDate(snapshot)})`;
	for (let attempt = 1; ; attempt++) {
		const folder = path.join(parent, `${label}${attempt > 1 ? ` ${attempt}` : ''}`);
		try {
			await mkdir(folder, { mode: stats.mode & 0o7777 });
		} catch (error) {
			if (error.code === 'EEXIST') {
				continue;
			}
			throw error;
		}

		if (await realpath(folder) !== folder) {
			throw new Error('The folder changed while restoring.');
		}
		return folder;
	}
};

const copySelection = async (job, module, root, selection, container, mode) => {
	const made = new Set([container]);
	let count = 0;
	const makeParents = async (target) => {
		const segments = path.relative(container, path.dirname(target)).split(path.sep).filter(Boolean);
		let folder = container;
		for (const segment of segments) {
			folder = path.join(folder, segment);
			if (!made.has(folder)) {
				await mkdir(folder, { mode });
				made.add(folder);
			}
		}
	};
	const copy = async (relPath, target) => {
		const source = `${root}${relPath}`;
		const stats = await lstat(source);
		if (!stats.isFile()) {
			return;
		}

		await copyFile(source, target, constants.COPYFILE_EXCL);
		await utimes(target, stats.atime, stats.mtime);
		count++;
		if (count % PROGRESS_STEP === 0) {
			await module.updateJobProgress(job, `Restoring files... ${count}`);
		}
	};
	const walk = async (relPath, target) => {
		const stats = await lstat(`${root}${relPath}`);
		if (!made.has(target)) {
			await mkdir(target, { mode });
			made.add(target);
		}

		const entries = await readdir(`${root}${relPath}`, { withFileTypes: true });
		for (const entry of entries) {
			const child = `${relPath}/${entry.name}`;
			if (selection.excluded.has(child)) {
				continue;
			}
			if (entry.isDirectory()) {
				await walk(child, path.join(target, entry.name));
			} else if (entry.isFile()) {
				await copy(child, path.join(target, entry.name));
			}
		}
		await utimes(target, stats.atime, stats.mtime);
	};

	for (const item of selection.items) {
		const target = path.join(container, item.path.slice(selection.common.length + 1));
		await makeParents(target);
		if (item.isDir) {
			await walk(item.path, target);
		} else {
			await copy(item.path, target);
		}
	}
	return count;
};

const restoreItems = async (job, module) => {
	const { config = {} } = job.data;
	const target = resolveTarget(config.dataset);
	const root = await resolveSnapshotRoot(target, config.snapshot);
	const selection = await resolveSelection(target, root, config);
	const destination = await resolveDestination(target, config.destination);
	await module.updateJobProgress(job, 'Restoring files...');
	const created = [];
	let container = null;
	try {
		let folder = destination.folder;
		for (const missing of destination.missing) {
			folder = await createFolder(target, folder, missing, destination.stats, created);
		}

		container = await createRestoreFolder(folder, config.snapshot, destination.stats);
		const count = await copySelection(job, module, root, selection, container, destination.stats.mode & 0o7777);
		if (target.isNextcloud) {
			await execa('chown', ['-R', '-h', '--', OWNER, container]);
		}
		const location = `${locationOf(target, config.destination)}/${path.basename(container)}`;
		return `${count} ${count === 1 ? 'file' : 'files'} restored to ${escapeHtml(location)}.`;
	} catch (error) {
		if (container) {
			await rm(container, { recursive: true, force: true });
		}
		for (const folder of created.reverse()) {
			await rmdir(folder).catch(() => {});
		}
		throw error;
	}
};

const restoreSelection = async (job, module) => {
	try {
		return await restoreItems(job, module);
	} catch (error) {
		throw new Error(escapeHtml(error.message));
	}
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
		'indexer:restore': { job: 'indexer:restore' },
		'indexer:restore:selection': { job: 'indexer:restore:selection' }
	},
	jobs: {
		'indexer:restore': restore,
		'indexer:restore:selection': restoreSelection
	}
};
