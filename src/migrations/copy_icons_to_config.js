import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { createLog } from '../utils/log.js';

const log = createLog('migrations');

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const OLD_APPS_ICONS = '/var/www/virgo-ui/app/dist/assets/img/apps';
const OLD_BOOKMARKS_ICONS = '/var/www/virgo-ui/app/dist/assets/img/bookmarks';
const NEW_ICONS_BASE = '/messier/.config/assets/img';
const NEW_APPS_ICONS = path.join(NEW_ICONS_BASE, 'apps');
const NEW_SHORTCUTS_ICONS = path.join(NEW_ICONS_BASE, 'shortcuts');

const copyIconsToConfig = async () => {
	const { exitCode: poolExists } = await execa('zpool', ['list', '-j', '-o', 'name', 'messier'], { reject: false });
	if (poolExists !== 0) {
		log.info(`ZFS pool 'messier' does not exist. Skipping icons copy.`);
		return;
	}

	const copyDirIfDestMissing = async (src, dest) => {
		try {
			await fs.access(dest);
			log.info(`${dest} already exists. Skipping.`);
			return;
		} catch (error) {
			// Destination does not exist, proceed with copy
		}
		try {
			await fs.access(src);
		} catch (error) {
			log.info(`Source directory does not exist: ${src}`);
			return;
		}
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.cp(src, dest, { recursive: true, force: false });
		log.info(`Copied ${src} -> ${dest}`);
	};

	await copyDirIfDestMissing(OLD_APPS_ICONS, NEW_APPS_ICONS);
	await copyDirIfDestMissing(OLD_BOOKMARKS_ICONS, NEW_SHORTCUTS_ICONS);

	log.info('Icons copy to config completed.');
};

if (isMainModule) {
	copyIconsToConfig()
		.catch((error) => {
			log.error('Icons copy failed:', error);
			process.exit(1);
		});
}

export default copyIconsToConfig;
