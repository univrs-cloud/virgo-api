const path = require('path');
const express = require('express');

const folderPath = path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist');
const staticMiddleware = express.static(folderPath, {
	index: false,
	dotfiles: 'deny',
	etag: false
});

/** Icons stored under messier config; path mirrors URL /assets/img/... */
const CONFIG_ASSETS_BASE = '/messier/.config/assets/img';
const appsIconsDir = path.join(CONFIG_ASSETS_BASE, 'apps');
const bookmarksIconsDir = path.join(CONFIG_ASSETS_BASE, 'bookmarks');
const configIconsOptions = { index: false, dotfiles: 'deny', etag: false };

/**
 * Controller for serving static files and the root HTML.
 * Serves app and bookmark icons from /messier/.config/ at /assets/img/apps and /assets/img/bookmarks.
 */
module.exports = {
	folderPath,
	staticMiddleware,
	appsIconsDir,
	bookmarksIconsDir,
	configIconsOptions
};
