const INDEXED_APP = 'nextcloud';
const INDEXED_DATASET = `messier/apps/${INDEXED_APP}`;
const INDEX_ROOT = '/data';
const TRASH_FOLDER = 'files_trashbin';
const USER_FOLDERS = ['files', TRASH_FOLDER];
const GROUP_FOLDERS = '__groupfolders';
const SYSTEM_FOLDERS = ['files_external'];
const SYSTEM_FOLDER_PREFIX = 'appdata_';
const SCOPE_VERSION = 8;

function escapeForERE(s) {
	return s.replace(/[.\\^$|()[\]*+?{}]/g, '\\$&');
}

function isInScope(relPath, isDir) {
	if (typeof relPath !== 'string') {
		return false;
	}
	if (relPath === INDEX_ROOT) {
		return isDir;
	}
	if (!relPath.startsWith(`${INDEX_ROOT}/`)) {
		return false;
	}

	const [top, sub, ...rest] = relPath.slice(INDEX_ROOT.length + 1).split('/');
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
}

function isTrash(relPath) {
	if (typeof relPath !== 'string' || !relPath.startsWith(`${INDEX_ROOT}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(INDEX_ROOT.length + 1).split('/');
	return top !== GROUP_FOLDERS && sub === TRASH_FOLDER;
}

function scopeGrepPattern(mountpoint) {
	if (typeof mountpoint !== 'string' || !mountpoint.startsWith('/')) {
		return null;
	}
	const TAB = '\t';
	const anchor = escapeForERE(mountpoint.replace(/\/+$/, ''));
	return `${TAB}${anchor}${escapeForERE(INDEX_ROOT)}(${TAB}|/|$)`;
}

export { INDEXED_APP, INDEXED_DATASET, INDEX_ROOT, SCOPE_VERSION, isInScope, isTrash, scopeGrepPattern };
