'use strict';

const { execaSync, execa } = require('execa');
const { createReadStream, promises: fsp, readdirSync, statSync, unlinkSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const readline = require('readline');
const { noiseGrepPattern } = require('./scope');

// ─── Temp file lifecycle ────────────────────────────────────────────────────
//
// `diffSnapshots` spools `zfs diff` stdout to a temp file under os.tmpdir().
// We keep two safety nets in case the process exits before the generator's
// `finally` runs:
//
//   1. Track every active temp path and unlink on the `exit` event. This
//      covers normal completion, uncaught exceptions, and signal handlers
//      that call process.exit().
//   2. Sweep tmpdir() at indexer startup (`cleanupStaleTempFiles`) and
//      delete any file matching our pattern whose owning PID is no longer
//      alive. This catches SIGKILL / OOM / power loss / hard crashes where
//      no JS exit hook gets a chance to run.

const TEMP_PREFIX = 'virgo-zfs-diff-';
const TEMP_PATTERN = /^virgo-zfs-diff-(\d+)-\d+\.tsv$/;
const activeTempFiles = new Set();
let tempSeq = 0;
let exitHandlersInstalled = false;

function installExitHandlers() {
	if (exitHandlersInstalled) {
		return;
	}
	exitHandlersInstalled = true;
	process.on('exit', () => {
		for (const f of activeTempFiles) {
			try { unlinkSync(f); } catch { /* ignore */ }
		}
		activeTempFiles.clear();
	});
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the process exists but we can't signal it (different
		// uid). Treat as alive — better to leave a temp file behind than
		// to clobber a live process's working data.
		return e.code === 'EPERM';
	}
}

// ─── Spool progress UI ──────────────────────────────────────────────────────

function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) {
		return '?';
	}
	const abs = Math.abs(bytes);
	if (abs < 1024) { return `${bytes}B`; }
	if (abs < 1024 ** 2) { return `${(bytes / 1024).toFixed(1)}K`; }
	if (abs < 1024 ** 3) { return `${(bytes / 1024 ** 2).toFixed(1)}M`; }
	return `${(bytes / 1024 ** 3).toFixed(2)}G`;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Show a live "spooling…" indicator while the awaited promise resolves,
 * so the user sees activity during the (potentially multi-minute) phase
 * where `zfs diff` runs to completion before we read the temp file.
 *
 * On a TTY we update a single line every 250ms with elapsed seconds and the
 * current size of the temp file. On non-TTY (logs, CI), we emit one line
 * at the start and a summary line when the promise settles.
 */
async function withSpoolProgress(promise, tmpPath, label) {
	const t0 = Date.now();
	const isTty = process.stdout.isTTY;

	let interval = null;
	if (isTty) {
		let tick = 0;
		const draw = () => {
			let bytes = 0;
			try { bytes = statSync(tmpPath).size; } catch { /* ignore */ }
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const frame = SPINNER[(++tick) % SPINNER.length];
			process.stdout.write(`\r    ${frame} ${label}… ${elapsed}s (${formatBytes(bytes)})\x1b[K`);
		};
		draw();
		interval = setInterval(draw, 250);
	} else {
		console.log(`    ${label}…`);
	}

	try {
		return await promise;
	} finally {
		if (interval) {
			clearInterval(interval);
			process.stdout.write('\r\x1b[K');
		} else {
			let bytes = 0;
			try { bytes = statSync(tmpPath).size; } catch { /* ignore */ }
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			console.log(`    ${label} done: ${formatBytes(bytes)} in ${elapsed}s`);
		}
	}
}

function cleanupStaleTempFiles() {
	const dir = tmpdir();
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of entries) {
		const m = TEMP_PATTERN.exec(name);
		if (!m) {
			continue;
		}
		const pid = Number.parseInt(m[1], 10);
		if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
			continue;
		}
		if (pidAlive(pid)) {
			continue;
		}
		try {
			unlinkSync(join(dir, name));
			removed++;
		} catch {
			/* ignore */
		}
	}
	return removed;
}

function zfsJson(subcmd, ...args) {
	const { stdout } = execaSync('zfs', [subcmd, '-j', '--json-int', ...args]);
	return JSON.parse(stdout);
}

function prop(properties, key) {
	return properties?.[key]?.value ?? null;
}

function discoverAll({ pool = null, dataset = null } = {}) {
	const json = zfsJson(
		'list',
		'-t', 'filesystem,snapshot',
		'-o', 'name,type,creation,used,referenced,mountpoint',
		'-r',
		...(dataset ? [dataset] : pool ? [pool] : [])
	);

	const datasets = [];
	const snapshots = [];

	for (const [fullName, entry] of Object.entries(json.datasets ?? {})) {
		const p = entry.properties;

		if (entry.type === 'FILESYSTEM') {
			if (!fullName.includes('/')) {
				continue;
			}

			const mountpoint = prop(p, 'mountpoint');
			datasets.push({
				name: fullName,
				pool: entry.pool,
				mountpoint: mountpoint === 'none' ? null : mountpoint,
				created_at: prop(p, 'creation'),
			});

		} else if (entry.type === 'SNAPSHOT') {
			const atIdx = fullName.indexOf('@');
			const datasetName = fullName.slice(0, atIdx);

			if (!datasetName.includes('/')) {
				continue;
			}

			const snapName = fullName.slice(atIdx + 1);

			snapshots.push({
				dataset_name: datasetName,
				name: snapName,
				full_name: fullName,
				created_at: prop(p, 'creation'),
				used_bytes: prop(p, 'used'),
				referenced_bytes: prop(p, 'referenced'),
			});
		}
	}

	snapshots.sort((a, b) => a.created_at - b.created_at);

	return { datasets, snapshots };
}

/**
 * Unescape octal sequences produced by `zfs diff -FHt`.
 * e.g. \040 → space, \011 → tab
 */
function unescapeZfsPath(str) {
	if (!str || !str.includes('\\')) {
		return str;
	}
	return str.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Stream `zfs diff` output via a temp file so the subprocess can run to
 * completion at full speed independent of how fast the consumer ingests
 * rows. Previously we piped stdout straight into the for-await consumer,
 * which meant any pause for DB writes blocked the pipe. On large diffs
 * (hundreds of thousands of changes) that backpressure caused `zfs diff`
 * to die with "Premature close" after multi-minute stalls.
 *
 * When a mountpoint is provided, the stream is pre-filtered through
 * `grep -v` against the noise pattern (db, redis, ...) so we never spend
 * disk space or JS parse time on change rows we'd just drop anyway. The
 * pattern is built from the same NOISE_DIR_NAMES set the walker uses, so
 * there's one source of truth for "what counts as noise".
 *
 * grep exits with code 1 when no lines matched — meaning *every* zfs diff
 * row was noise. That's a perfectly valid outcome for us, not an error.
 */
async function* diffSnapshots(snapA, snapB, mountpoint = null) {
	installExitHandlers();
	const tmpPath = join(tmpdir(), `${TEMP_PREFIX}${process.pid}-${++tempSeq}.tsv`);
	activeTempFiles.add(tmpPath);

	try {
		const pattern = noiseGrepPattern(mountpoint);
		let result;
		let zfsResult;

		if (pattern) {
			const promise = execa('zfs', ['diff', '-FHt', snapA, snapB], {
				reject: false,
				stderr: 'pipe',
			}).pipe('grep', ['-vE', pattern], {
				reject: false,
				stdout: { file: tmpPath },
				stderr: 'pipe',
			});
			result = await withSpoolProgress(promise, tmpPath, 'Spooling zfs diff (filtered)');
			zfsResult = result.pipedFrom?.[0] ?? null;
		} else {
			const promise = execa('zfs', ['diff', '-FHt', snapA, snapB], {
				reject: false,
				stdout: { file: tmpPath },
				stderr: 'pipe',
			});
			result = await withSpoolProgress(promise, tmpPath, 'Spooling zfs diff');
			zfsResult = result;
		}

		if (zfsResult && (zfsResult.exitCode !== 0 || zfsResult.signal)) {
			const stderr = (zfsResult.stderr && zfsResult.stderr.toString().trim()) || '';
			const msg = stderr
				|| `zfs diff exited with code ${zfsResult.exitCode}${zfsResult.signal ? ` (signal ${zfsResult.signal})` : ''}`;
			const e = new Error(msg);
			e.code = 'ZFS_DIFF_FAILED';
			e.exitCode = zfsResult.exitCode;
			e.snapA = snapA;
			e.snapB = snapB;
			throw e;
		}

		// When piped through grep: 0 = matches emitted, 1 = nothing
		// survived (entirely-noise diff — valid for us), >1 = real grep
		// failure. When unfiltered, only 0 is success.
		const ok = pattern ? (result.exitCode === 0 || result.exitCode === 1) : (result.exitCode === 0);
		if (!ok) {
			const stderr = (result.stderr && result.stderr.toString().trim()) || '';
			const msg = stderr
				|| `${pattern ? 'grep' : 'zfs diff'} exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}`;
			const e = new Error(pattern ? `noise filter failed: ${msg}` : msg);
			e.code = 'ZFS_DIFF_FAILED';
			e.exitCode = result.exitCode;
			e.snapA = snapA;
			e.snapB = snapB;
			throw e;
		}

		const rl = readline.createInterface({
			input: createReadStream(tmpPath, { encoding: 'utf8' }),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			const entry = parseDiffLine(line);
			if (entry) {
				yield entry;
			}
		}
	} finally {
		activeTempFiles.delete(tmpPath);
		try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
	}
}

function isZfsDiffFailure(err) {
	return Boolean(err && err.code === 'ZFS_DIFF_FAILED');
}

const CHANGE_MAP = {
	'+': 'added',
	'-': 'removed',
	'M': 'modified',
	'R': 'renamed',
};

const FILETYPE_MAP = {
	'F': 'file',
	'/': 'dir',
	'@': 'link',
	'B': 'block',
	'C': 'char',
	'P': 'pipe',
	'=': 'socket',
};

function parseDiffLine(line) {
	if (!line.trim()) {
		return null;
	}

	const parts = line.split('\t');
	if (parts.length < 4) {
		return null;
	}

	const changedAt = Math.floor(parseFloat(parts[0]));
	const changeChar = parts[1];
	const typeChar = parts[2];
	const rawPath = parts[3];
	const rawNewPath = parts[4] ?? null;

	const changeType = CHANGE_MAP[changeChar];
	if (!changeType) {
		console.warn(`  ⚠  Unknown zfs diff change type '${changeChar}' for path: ${rawPath}`);
	}

	return {
		changeType: changeType ?? 'unknown',
		fileType: FILETYPE_MAP[typeChar] ?? 'other',
		path: unescapeZfsPath(rawPath),
		newPath: rawNewPath ? unescapeZfsPath(rawNewPath) : null,
		changedAt,
	};
}

function snapshotMountPath(datasetMountpoint, snapshotName) {
	if (!datasetMountpoint) {
		return null;
	}
	return `${datasetMountpoint}/.zfs/snapshot/${snapshotName}`;
}

module.exports = { discoverAll, diffSnapshots, snapshotMountPath, isZfsDiffFailure, cleanupStaleTempFiles };
