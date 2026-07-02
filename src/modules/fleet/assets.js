import path from 'path';

const ASSET_PREFIXES = {
	'/assets/img/apps/': '/messier/.config/assets/img/apps/',
	'/assets/img/bookmarks/': '/messier/.config/assets/img/bookmarks/'
};

const MIME_BY_EXTENSION = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.gif': 'image/gif'
};

function resolveAssetFile(assetPath) {
	for (const [prefix, root] of Object.entries(ASSET_PREFIXES)) {
		if (!assetPath.startsWith(prefix)) {
			continue;
		}
		const fileName = assetPath.slice(prefix.length);
		if (!fileName || fileName.includes('..') || fileName.includes('/')) {
			return null;
		}
		return path.join(root, fileName);
	}
	return null;
}

function contentTypeForPath(filePath) {
	return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export {
	resolveAssetFile,
	contentTypeForPath
};
