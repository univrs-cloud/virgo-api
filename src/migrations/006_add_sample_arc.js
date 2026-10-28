import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const STATS_DATABASE_FILE = '/messier/.config/stats.db';

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const addSampleArc = async () => {
	try {
		if (!await exists(STATS_DATABASE_FILE)) {
			console.log(`No stats database file found. Skipping the sample arc column.`);
			return;
		}

		const { sequelize } = await import('../database/stats.js');
		const { QueryTypes } = await import('sequelize');

		const columns = await sequelize.query('PRAGMA table_info(`Samples`)', { type: QueryTypes.SELECT });
		if (columns.length === 0) {
			console.log(`No Samples table found. Skipping the sample arc column.`);
			return;
		}

		if (columns.some((column) => { return column.name.toLowerCase() === 'arc'; })) {
			console.log(`Samples already has the arc column. Skipping.`);
			return;
		}

		await sequelize.query('ALTER TABLE `Samples` ADD COLUMN `arc` INTEGER NOT NULL DEFAULT 0');
		console.log(`Added the arc column to Samples.`);
	} catch (error) {
		console.error(`Adding the sample arc column failed:`, error);
	}
};

if (isMainModule) {
	addSampleArc();
}

export default addSampleArc;
