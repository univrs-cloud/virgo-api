const NEXTCLOUD_APP = 'nextcloud';
const NEXTCLOUD_DATASET = `messier/apps/${NEXTCLOUD_APP}`;
const FOLDERS_DATASET = 'messier/folders';
const NEXTCLOUD_DATA = '/data';
const NEXTCLOUD_TRASH = 'files_trashbin';
const NEXTCLOUD_USER_FOLDERS = ['files', NEXTCLOUD_TRASH];
const NEXTCLOUD_GROUP_FOLDERS = '__groupfolders';
const NEXTCLOUD_SYSTEM_FOLDERS = ['files_external'];
const NEXTCLOUD_SYSTEM_FOLDER_PREFIX = 'appdata_';
const SCOPE_VERSION = 8;

function escapeForERE(s) {
	return s.replace(/[.\\^$|()[\]*+?{}]/g, '\\$&');
}

function isNextcloud(dataset) {
	return String(dataset ?? '').toLowerCase() === NEXTCLOUD_DATASET;
}

function isInScope(dataset, relPath, isDir) {
	if (typeof relPath !== 'string') {
		return false;
	}
	if (!isNextcloud(dataset)) {
		return String(dataset ?? '').toLowerCase() !== FOLDERS_DATASET;
	}
	if (relPath === NEXTCLOUD_DATA) {
		return isDir;
	}
	if (!relPath.startsWith(`${NEXTCLOUD_DATA}/`)) {
		return false;
	}

	const [top, sub, ...rest] = relPath.slice(NEXTCLOUD_DATA.length + 1).split('/');
	if (top.startsWith(NEXTCLOUD_SYSTEM_FOLDER_PREFIX) || NEXTCLOUD_SYSTEM_FOLDERS.includes(top)) {
		return false;
	}
	if (sub === undefined) {
		return isDir;
	}
	if (top === NEXTCLOUD_GROUP_FOLDERS) {
		return true;
	}
	if (!NEXTCLOUD_USER_FOLDERS.includes(sub)) {
		return false;
	}
	return (rest.length > 0 || isDir);
}

function isTrash(dataset, relPath) {
	if (!isNextcloud(dataset) || typeof relPath !== 'string' || !relPath.startsWith(`${NEXTCLOUD_DATA}/`)) {
		return false;
	}

	const [top, sub] = relPath.slice(NEXTCLOUD_DATA.length + 1).split('/');
	return top !== NEXTCLOUD_GROUP_FOLDERS && sub === NEXTCLOUD_TRASH;
}

function scopeGrepPattern(dataset, mountpoint) {
	if (!isNextcloud(dataset) || typeof mountpoint !== 'string' || !mountpoint.startsWith('/')) {
		return null;
	}
	const TAB = '\t';
	const anchor = escapeForERE(mountpoint.replace(/\/+$/, ''));
	return `${TAB}${anchor}${escapeForERE(NEXTCLOUD_DATA)}(${TAB}|/|$)`;
}

export { NEXTCLOUD_APP, NEXTCLOUD_DATASET, FOLDERS_DATASET, NEXTCLOUD_DATA, SCOPE_VERSION, isInScope, isTrash, scopeGrepPattern };
