'use strict';

/**
 * Top-level directories at a dataset root that we ALWAYS skip during indexing.
 *
 * These are well-known noise from common self-hosted app workloads:
 *
 *   - `db`    — MariaDB / PostgreSQL data files. Churn constantly with no
 *               useful artifacts to surface in search results.
 *   - `redis` — Redis RDB/AOF dumps. Binary streams that rewrite themselves
 *               on every snapshot.
 *
 * Match is by the FIRST path component only (relative to the dataset's
 * mountpoint), so `/db` and `/db/whatever` are skipped but `/data/db` is not.
 *
 * This list is intentionally hardcoded — the indexer auto-applies it to every
 * dataset it sees. The user-facing toggle stays "enable/disable indexing for
 * this dataset" with no per-path config required.
 */
const NOISE_DIR_NAMES = new Set(['db', 'redis']);

function topLevelDirName(relPath) {
	if (typeof relPath !== 'string' || relPath === '/' || !relPath.startsWith('/')) {
		return null;
	}
	const next = relPath.indexOf('/', 1);
	return next === -1 ? relPath.slice(1) : relPath.slice(1, next);
}

function isNoisePath(relPath) {
	const top = topLevelDirName(relPath);
	return top !== null && NOISE_DIR_NAMES.has(top);
}

function noisePrefixes() {
	return [...NOISE_DIR_NAMES].map(n => `/${n}`);
}

function escapeForERE(s) {
	return s.replace(/[.\\^$|()[\]*+?{}]/g, '\\$&');
}

/**
 * Build a `grep -E` pattern that matches a noise path appearing in any
 * tab-delimited field of a `zfs diff -FHt` line.
 *
 * zfs diff emits ABSOLUTE filesystem paths (e.g.
 * `/messier/apps/nextcloud/db/file`), not paths relative to the dataset
 * mountpoint. So we anchor on `<TAB><mountpoint>/(noise)(<TAB>|/|<EOL>)`.
 *
 * The trailing `(\t|/|$)` is the boundary check: it ensures we match the
 * `db` directory and its subtree but NOT siblings whose names happen to
 * start with `db` (e.g. `/dbcache`) or root files like `/db.sql`.
 *
 * The pattern uses literal tab characters (POSIX ERE matches a literal tab
 * directly); `\t` as a portable escape across grep implementations is iffy.
 */
function noiseGrepPattern(mountpoint) {
	if (typeof mountpoint !== 'string' || !mountpoint.startsWith('/')) {
		return null;
	}
	const TAB = '\t';
	const alt = [...NOISE_DIR_NAMES].join('|');
	const anchor = escapeForERE(mountpoint.replace(/\/+$/, ''));
	return `${TAB}${anchor}/(${alt})(${TAB}|/|$)`;
}

module.exports = { NOISE_DIR_NAMES, isNoisePath, noisePrefixes, noiseGrepPattern };
