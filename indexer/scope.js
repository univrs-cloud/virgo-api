/**
 * Directory subtrees that we ALWAYS skip during indexing.
 *
 * Two flavours:
 *
 * 1. NOISE_DIR_NAMES — exact directory names matched ONLY at the dataset
 *    root. e.g. `db` skips `/db` and `/db/**` but NOT `/data/db`.
 *
 *    - `db`    — MariaDB / PostgreSQL data files. Constant churn, useless
 *                for search.
 *    - `redis` — Redis RDB/AOF dumps. Binary, rewritten every snapshot.
 *
 * 2. NOISE_DIR_GLOBS — glob patterns matched against the relative path
 *    (rooted at the mountpoint, no leading slash). `*` matches any single
 *    path segment (i.e. anything except `/`). The whole pattern must match
 *    the entire relative path of a directory.
 *
 *    - `data/appdata_<hash>/preview` — Nextcloud's preview pyramid: hundreds
 *                                       of thousands of tiny thumbnail tiles
 *                                       under every appdata directory. Churns
 *                                       on every file view, never user-visible.
 *                                       The rest of appdata (avatars, password
 *                                       backups, etc.) is kept.
 *
 *    - `config/www/nextcloud/apps`    — Nextcloud's installed app bundles. PHP
 *                                       source updated on every app upgrade,
 *                                       not user content, not searchable.
 *
 * Both lists are hardcoded. The user-facing toggle stays "enable/disable
 * indexing for this dataset" — no per-path config.
 */
const NOISE_DIR_NAMES = new Set(['db', 'redis']);
const NOISE_DIR_GLOBS = [
	'**/appdata_*/preview',
	'**/www/nextcloud/apps',
];

// Bump whenever the patterns above change. A pass whose stored version differs
// sweeps rows indexed under the older, narrower patterns — otherwise content we
// now exclude would sit in the index forever.
//
// v2: appdata/preview and the Nextcloud app bundles were anchored at `data/` and
// `config/`, which only matches a dataset mounted above the Nextcloud data dir.
// A dataset mounted at the data dir itself puts them at the root, so the preview
// pyramid was indexed in full — on one production node, 73% of every row.
const NOISE_SCOPE_VERSION = 2;

function escapeForERE(s) {
	return s.replace(/[.\\^$|()[\]*+?{}]/g, '\\$&');
}

// Convert a glob to an ERE fragment. A single `*` matches within one path
// segment. A leading double-star segment matches any number of leading
// segments, so a pattern applies wherever that subtree sits relative to the
// dataset mountpoint. Every other regex metachar is escaped. The group is
// capturing, not non-capturing, because POSIX ERE (grep -E) has no "(?:".
function globToERE(glob) {
	let out = '';
	let start = 0;
	if (glob.startsWith('**/')) {
		out += '([^/]+/)*';
		start = 3;
	}
	for (let i = start; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			out += '[^/]*';
		} else if ('.\\^$|()[]+?{}'.includes(c)) {
			out += '\\' + c;
		} else {
			out += c;
		}
	}
	return out;
}

const NOISE_GLOB_REGEXES = NOISE_DIR_GLOBS.map(g => new RegExp('^' + globToERE(g) + '(?:/|$)'));

function topLevelDirName(relPath) {
	if (typeof relPath !== 'string' || relPath === '/' || !relPath.startsWith('/')) {
		return null;
	}
	const next = relPath.indexOf('/', 1);
	return next === -1 ? relPath.slice(1) : relPath.slice(1, next);
}

function isNoisePath(relPath) {
	if (typeof relPath !== 'string' || !relPath.startsWith('/')) {
		return false;
	}
	const top = topLevelDirName(relPath);
	if (top !== null && NOISE_DIR_NAMES.has(top)) {
		return true;
	}
	const rel = relPath.slice(1);
	for (const re of NOISE_GLOB_REGEXES) {
		if (re.test(rel)) {
			return true;
		}
	}
	return false;
}

function noisePrefixes() {
	return [...[...NOISE_DIR_NAMES].map(n => `/${n}`), ...NOISE_DIR_GLOBS.map(g => `/${g}`)];
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
	const anchor = escapeForERE(mountpoint.replace(/\/+$/, ''));
	const names = [...NOISE_DIR_NAMES].map(escapeForERE);
	const globs = NOISE_DIR_GLOBS.map(globToERE);
	const alt = [...names, ...globs].join('|');
	return `${TAB}${anchor}/(${alt})(${TAB}|/|$)`;
}

export { NOISE_DIR_NAMES, NOISE_DIR_GLOBS, NOISE_SCOPE_VERSION, isNoisePath, noisePrefixes, noiseGrepPattern };
