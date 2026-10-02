import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const DATABASE_FILE = '/messier/.config/virgo.db';

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const addRestoreZonesToApplications = async () => {
	try {
		if (!await exists(DATABASE_FILE)) {
			console.log(`No database file found. Skipping the restore zones column.`);
			return;
		}

		const { sequelize } = await import('../database/index.js');
		const { QueryTypes } = await import('sequelize');

		const columns = await sequelize.query('PRAGMA table_info(`Applications`)', { type: QueryTypes.SELECT });
		if (columns.length === 0) {
			console.log(`No Applications table found. Skipping the restore zones column.`);
			return;
		}

		if (columns.some((column) => { return column.name.toLowerCase() === 'restorezones'; })) {
			console.log(`Applications already has the restore zones column. Skipping.`);
			return;
		}

		await sequelize.query('ALTER TABLE `Applications` ADD COLUMN `restoreZones` JSON');
		console.log(`Added the restore zones column to Applications.`);
	} catch (error) {
		console.error(`Adding the restore zones column failed:`, error);
	}
};

if (isMainModule) {
	addRestoreZonesToApplications();
}

export default addRestoreZonesToApplications;
