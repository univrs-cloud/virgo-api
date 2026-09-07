import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const folderPath = path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist');
const staticMiddleware = express.static(folderPath, {
	index: false,
	dotfiles: 'deny',
	etag: false
});

/** Icons stored under messier config; path mirrors URL /assets/img/... */
const CONFIG_ASSETS_BASE = '/messier/.config/assets/img';
const appsIconsDir = path.join(CONFIG_ASSETS_BASE, 'apps');
const shortcutsIconsDir = path.join(CONFIG_ASSETS_BASE, 'shortcuts');
const configIconsOptions = { index: false, dotfiles: 'deny', etag: false };

/**
 * Controller for serving static files and the root HTML.
 * Serves app and shortcut icons from /messier/.config/ at /assets/img/apps and /assets/img/shortcuts.
 */
export {
	folderPath,
	staticMiddleware,
	appsIconsDir,
	shortcutsIconsDir,
	configIconsOptions
};
