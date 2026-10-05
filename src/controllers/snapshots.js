import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { lstat, readdir, realpath, stat } from 'fs/promises';
import express from 'express';
import * as authelia from '../utils/authelia.js';

const SNAPSHOT_PATH_PATTERN = /^\/messier\/apps\/nextcloud\/\.zfs\/snapshot\/[^/]+(\/.+)$/;
const SNAPSHOTS_ROOT = '/messier/apps/nextcloud/.zfs/snapshot';
const SELECTION_LIMIT = '8mb';
const MAX_SELECTION_PATHS = 50000;
const DATA_ROOT = '/data';
const USER_FOLDERS = ['files', 'files_trashbin'];
const GROUP_FOLDERS = '__groupfolders';
const SYSTEM_FOLDERS = ['files_external'];
const SYSTEM_FOLDER_PREFIX = 'appdata_';

const router = express.Router();

const isUserContent = (relPath, isDir) => {
	if (relPath === DATA_ROOT) {
		return isDir;
	}
	if (!relPath.startsWith(`${DATA_ROOT}/`)) {
		return false;
	}

	const [top, sub, ...rest] = relPath.slice(DATA_ROOT.length + 1).split('/');
	if (top.startsWith(SYSTEM_FOLDER_PREFIX) || SYSTEM_FOLDERS.includes(top)) {
		return false;
	}
	if (sub === undefined) {
		return isDir;
	}
	if (top === GROUP_FOLDERS) {
		return true;
	}
	if (!USER_FOLDERS.includes(sub)) {
		return false;
	}
	return (rest.length > 0 || isDir);
};

const sendFolder = (target, res) => {
	const name = path.basename(target);
	const zip = spawn('zip', ['-r', '-q', '-y', '-0', '-nw', '-', '--', name], { cwd: path.dirname(target), stdio: ['ignore', 'pipe', 'ignore'] });
	let isFailed = false;
	const fail = () => {
		isFailed = true;
		zip.kill();
		if (res.headersSent) {
			res.destroy();
			return;
		}

		res.removeHeader('Content-Disposition');
		res.sendStatus(500);
	};

	zip.on('error', fail);
	zip.on('close', (code) => {
		if (isFailed) {
			return;
		}

		if (code !== 0) {
			fail();
			return;
		}

		res.end();
	});
	res.on('close', () => {
		zip.kill();
	});

	res.attachment(`${name}.zip`);
	zip.stdout.pipe(res, { end: false });
};

const authorizeAdmin = async (req, res) => {
	let authorization;
	try {
		authorization = await authelia.authorize({
			fqdn: req.hostname,
			uri: req.originalUrl,
			clientAddress: req.ip,
			cookie: req.headers.cookie
		});
	} catch (error) {
		res.sendStatus(503);
		return false;
	}

	if (!authorization.isAllowed || !authorization.identity) {
		res.sendStatus(401);
		return false;
	}

	if (!authorization.identity.isAdmin) {
		res.sendStatus(403);
		return false;
	}

	return true;
};

const isCleanPath = (value) => {
	return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !value.includes('\n') && !value.endsWith('/') && path.posix.normalize(value) === value;
};

const isInside = (child, folder) => {
	return child.startsWith(`${folder}/`);
};

const resolveSnapshotRoot = async (snapshot) => {
	if (typeof snapshot !== 'string' || !snapshot || snapshot.includes('/') || snapshot.includes('\0') || ['.', '..'].includes(snapshot)) {
		return null;
	}

	try {
		const root = await realpath(`${SNAPSHOTS_ROOT}/${snapshot}`);
		return (root === `${SNAPSHOTS_ROOT}/${snapshot}` ? root : null);
	} catch (error) {
		return null;
	}
};

const resolveSelection = async (root, selection) => {
	const paths = (Array.isArray(selection?.items) ? selection.items : []);
	const excluded = (Array.isArray(selection?.excluded) ? selection.excluded : []);
	if (!paths.length || paths.length + excluded.length > MAX_SELECTION_PATHS || !paths.every(isCleanPath) || !excluded.every(isCleanPath)) {
		return null;
	}

	const items = [];
	for (const relPath of [...new Set(paths)].sort()) {
		if (items.some((item) => { return item.isDir && isInside(relPath, item.path); })) {
			continue;
		}

		let stats;
		try {
			if (await realpath(`${root}${relPath}`) !== `${root}${relPath}`) {
				return null;
			}
			stats = await lstat(`${root}${relPath}`);
		} catch (error) {
			return null;
		}

		if ((!stats.isFile() && !stats.isDirectory()) || !isUserContent(relPath, stats.isDirectory())) {
			return null;
		}
		items.push({ path: relPath, isDir: stats.isDirectory() });
	}

	let common = path.posix.dirname(items[0].path);
	while (common !== '/' && !items.every((item) => { return isInside(item.path, common); })) {
		common = path.posix.dirname(common);
	}
	if (common === '/') {
		return null;
	}

	return { items, excluded: new Set(excluded), common };
};

const selectionName = (selection) => {
	if (selection.items.length === 1) {
		return path.posix.basename(selection.items[0].path);
	}

	const [, , user, , ...rest] = selection.common.split('/');
	return (rest.length ? rest[rest.length - 1] : (user || 'nextcloud'));
};

const listSelection = async (zip, root, selection) => {
	const write = async (relPath) => {
		if (!zip.stdin.writable) {
			throw new Error('Archive closed.');
		}
		if (!zip.stdin.write(`${relPath.slice(selection.common.length + 1)}\n`)) {
			await once(zip.stdin, 'drain');
		}
	};
	const walk = async (relPath) => {
		await write(relPath);
		const entries = await readdir(`${root}${relPath}`, { withFileTypes: true });
		for (const entry of entries) {
			const child = `${relPath}/${entry.name}`;
			if (selection.excluded.has(child) || entry.name.includes('\n')) {
				continue;
			}
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile()) {
				await write(child);
			}
		}
	};

	for (const item of selection.items) {
		if (item.isDir) {
			await walk(item.path);
		} else {
			await write(item.path);
		}
	}
	zip.stdin.end();
};

const sendSelection = (root, selection, res) => {
	const zip = spawn('zip', ['-q', '-y', '-0', '-nw', '-', '-@'], { cwd: `${root}${selection.common}`, stdio: ['pipe', 'pipe', 'ignore'] });
	let isFailed = false;
	const fail = () => {
		if (isFailed) {
			return;
		}

		isFailed = true;
		zip.kill();
		if (res.headersSent) {
			res.destroy();
			return;
		}

		res.removeHeader('Content-Disposition');
		res.sendStatus(500);
	};

	zip.on('error', fail);
	zip.stdin.on('error', () => {});
	zip.on('close', (code) => {
		if (isFailed) {
			return;
		}

		if (code !== 0) {
			fail();
			return;
		}

		res.end();
	});
	res.on('close', () => {
		zip.kill();
	});

	res.attachment(`${selectionName(selection)}.zip`);
	zip.stdout.pipe(res, { end: false });
	listSelection(zip, root, selection).catch(fail);
};

router.get('/snapshots/download', async (req, res, next) => {
	if (!await authorizeAdmin(req, res)) {
		return;
	}

	const requested = req.query.path;
	if (typeof requested !== 'string' || !path.isAbsolute(requested) || !SNAPSHOT_PATH_PATTERN.test(path.resolve(requested))) {
		res.sendStatus(400);
		return;
	}

	let target;
	let stats;
	try {
		target = await realpath(path.resolve(requested));
		stats = await stat(target);
	} catch (error) {
		res.sendStatus(404);
		return;
	}

	const relPath = SNAPSHOT_PATH_PATTERN.exec(target)?.[1];
	if (!relPath || (!stats.isFile() && !stats.isDirectory()) || !isUserContent(relPath, stats.isDirectory())) {
		res.sendStatus(404);
		return;
	}

	res.setHeader('Cache-Control', 'no-transform');
	if (stats.isDirectory()) {
		sendFolder(target, res);
		return;
	}

	res.download(target, path.basename(target), { dotfiles: 'allow' }, (error) => {
		if (error && !res.headersSent) {
			next(error);
		}
	});
});

router.post('/snapshots/download', express.urlencoded({ extended: false, limit: SELECTION_LIMIT }), async (req, res, next) => {
	if (!await authorizeAdmin(req, res)) {
		return;
	}

	let requested;
	try {
		requested = JSON.parse(req.body?.selection);
	} catch (error) {
		res.sendStatus(400);
		return;
	}

	const root = await resolveSnapshotRoot(requested?.snapshot);
	if (!root) {
		res.sendStatus(404);
		return;
	}

	const selection = await resolveSelection(root, requested);
	if (!selection) {
		res.sendStatus(400);
		return;
	}

	res.setHeader('Cache-Control', 'no-transform');
	if (selection.items.length === 1 && !selection.items[0].isDir) {
		const target = `${root}${selection.items[0].path}`;
		res.download(target, path.basename(target), { dotfiles: 'allow' }, (error) => {
			if (error && !res.headersSent) {
				next(error);
			}
		});
		return;
	}

	sendSelection(root, selection, res);
});

export default router;
