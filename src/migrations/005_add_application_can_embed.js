import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLog } from '../utils/log.js';

const log = createLog('migrations');

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const DATABASE_FILE = '/messier/.config/virgo.db';
const FETCH_TIMEOUT = 15000;

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const findTemplate = (templates, appName) => {
	const name = String(appName ?? '').toLowerCase();
	const exact = templates.find((template) => { return String(template?.name ?? '').toLowerCase() === name; });
	if (exact) {
		return exact;
	}

	return templates.find((template) => {
		return template?.multiple === true && name.startsWith(`${String(template.name ?? '').toLowerCase()}-`);
	});
};

const fetchTemplates = async () => {
	const { default: config } = await import('../../config.js');
	const response = await fetch(config.apps.templatesUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
	if (!response.ok) {
		throw new Error(`Templates request failed with status ${response.status}.`);
	}

	const data = await response.json();
	return (Array.isArray(data?.templates) ? data.templates : []);
};

const addApplicationCanEmbed = async () => {
	try {
		if (!await exists(DATABASE_FILE)) {
			log.info(`No database file found. Skipping the application canEmbed column.`);
			return;
		}

		const { sequelize } = await import('../database/index.js');
		const { QueryTypes } = await import('sequelize');

		const columns = await sequelize.query('PRAGMA table_info(`Applications`)', { type: QueryTypes.SELECT });
		if (columns.length === 0) {
			log.info(`No Applications table found. Skipping the application canEmbed column.`);
			return;
		}

		if (columns.some((column) => { return column.name.toLowerCase() === 'canembed'; })) {
			log.info(`Applications already has the canEmbed column. Skipping.`);
			return;
		}

		await sequelize.query('ALTER TABLE `Applications` ADD COLUMN `canEmbed` TINYINT(1)');
		log.info(`Added the canEmbed column to Applications.`);

		const templates = await fetchTemplates();
		const applications = await sequelize.query('SELECT `id`, `name` FROM `Applications`', { type: QueryTypes.SELECT });
		for (const application of applications) {
			const template = findTemplate(templates, application.name);
			if (typeof template?.embed !== 'boolean') {
				continue;
			}

			await sequelize.query(
				'UPDATE `Applications` SET `canEmbed` = ? WHERE `id` = ?',
				{ replacements: [(template.embed ? 1 : 0), application.id] }
			);
			log.info(`Set canEmbed to ${template.embed} for ${application.name}.`);
		}

		log.info(`Application canEmbed values set from the templates successfully!`);
	} catch (error) {
		log.error(`Adding the application canEmbed column failed:`, error);
	}
};

if (isMainModule) {
	addApplicationCanEmbed();
}

export default addApplicationCanEmbed;
