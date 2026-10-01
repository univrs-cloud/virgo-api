import path from 'path';
import { spawn } from 'child_process';
import { realpath, stat } from 'fs/promises';
import express from 'express';
import * as authelia from '../utils/authelia.js';

const SNAPSHOT_PATH_PATTERN = /^\/.+\/\.zfs\/snapshot\/[^/]+\/.+$/;

const router = express.Router();

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

router.get('/snapshots/download', async (req, res, next) => {
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
		return;
	}

	if (!authorization.isAllowed || !authorization.identity) {
		res.sendStatus(401);
		return;
	}

	if (!authorization.identity.isAdmin) {
		res.sendStatus(403);
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

	if (!SNAPSHOT_PATH_PATTERN.test(target) || (!stats.isFile() && !stats.isDirectory())) {
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

export default router;
