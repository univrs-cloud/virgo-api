import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const OLD_APPS_ICONS = '/var/www/virgo-ui/app/dist/assets/img/apps';
const OLD_BOOKMARKS_ICONS = '/var/www/virgo-ui/app/dist/assets/img/bookmarks';
const NEW_ICONS_BASE = '/messier/.config/assets/img';
const NEW_APPS_ICONS = path.join(NEW_ICONS_BASE, 'apps');
const NEW_BOOKMARKS_ICONS = path.join(NEW_ICONS_BASE, 'bookmarks');

const copyIconsToConfig = async () => {
	try {
		await execa('zpool', ['list', 'messier']);
	} catch (error) {
		console.log(`ZFS pool 'messier' does not exist. Skipping icons copy.`);
		return;
	}

	const copyDirIfDestMissing = async (src, dest) => {
		try {
			await fs.access(dest);
			console.log(`${dest} already exists. Skipping.`);
			return;
		} catch (error) {
			// Destination does not exist, proceed with copy
		}
		try {
			await fs.access(src);
		} catch (error) {
			console.log(`Source directory does not exist: ${src}`);
			return;
		}
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.cp(src, dest, { recursive: true, force: false });
		console.log(`Copied ${src} -> ${dest}`);
	};

	await copyDirIfDestMissing(OLD_APPS_ICONS, NEW_APPS_ICONS);
	await copyDirIfDestMissing(OLD_BOOKMARKS_ICONS, NEW_BOOKMARKS_ICONS);

	console.log('Icons copy to config completed.');
};

if (isMainModule) {
	copyIconsToConfig().catch((error) => {
		console.error('Icons copy failed:', error);
		process.exit(1);
	});
}

export default copyIconsToConfig;
