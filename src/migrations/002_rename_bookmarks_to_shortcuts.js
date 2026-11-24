import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLog } from '../utils/log.js';

const log = createLog('migrations');

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const DATABASE_FILE = '/messier/.config/virgo.db';
const OLD_ICONS_DIR = '/messier/.config/assets/img/bookmarks';
const NEW_ICONS_DIR = '/messier/.config/assets/img/shortcuts';

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const tableExists = async (sequelize, QueryTypes, name) => {
	const rows = await sequelize.query(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		{ replacements: [name], type: QueryTypes.SELECT }
	);
	return rows.length > 0;
};

const countRows = async (sequelize, QueryTypes, name) => {
	const [row] = await sequelize.query(`SELECT COUNT(*) AS total FROM \`${name}\``, { type: QueryTypes.SELECT });
	return row?.total ?? 0;
};

const renameShortcutsTable = async (sequelize, QueryTypes) => {
	if (!await tableExists(sequelize, QueryTypes, 'Bookmarks')) {
		log.info(`No Bookmarks table found. Skipping table rename.`);
		return;
	}

	if (await tableExists(sequelize, QueryTypes, 'Shortcuts')) {
		if (await countRows(sequelize, QueryTypes, 'Shortcuts') > 0) {
			log.info(`Shortcuts table already holds rows. Leaving Bookmarks in place for manual review.`);
			return;
		}
		await sequelize.query('DROP TABLE `Shortcuts`');
		log.info(`Dropped the empty Shortcuts table left by a model sync.`);
	}

	await sequelize.query('ALTER TABLE `Bookmarks` RENAME TO `Shortcuts`');
	log.info(`Renamed Bookmarks to Shortcuts.`);
};

const rebuildItemOrders = async (sequelize, QueryTypes, createSql) => {
	const indexes = await sequelize.query(
		`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ItemOrders' AND sql IS NOT NULL`,
		{ type: QueryTypes.SELECT }
	);
	const columns = await sequelize.query('PRAGMA table_info(`ItemOrders`)', { type: QueryTypes.SELECT });
	const columnList = columns.map((column) => { return `\`${column.name}\``; }).join(', ');
	const selectList = columns.map((column) => {
		if (column.name !== 'type') {
			return `\`${column.name}\``;
		}
		return `CASE \`type\` WHEN 'bookmark' THEN 'shortcut' ELSE \`type\` END`;
	}).join(', ');
	const createTable = createSql
		.replace(/CREATE TABLE\s+(`ItemOrders`|"ItemOrders"|\[ItemOrders\]|ItemOrders)/i, 'CREATE TABLE `ItemOrders_migration`')
		.replace(/'bookmark'/g, `'shortcut'`);

	await sequelize.query('PRAGMA foreign_keys = OFF');
	const transaction = await sequelize.transaction();
	try {
		await sequelize.query(createTable, { transaction });
		await sequelize.query(
			`INSERT INTO \`ItemOrders_migration\` (${columnList}) SELECT ${selectList} FROM \`ItemOrders\``,
			{ transaction }
		);
		await sequelize.query('DROP TABLE `ItemOrders`', { transaction });
		await sequelize.query('ALTER TABLE `ItemOrders_migration` RENAME TO `ItemOrders`', { transaction });
		for (const index of indexes) {
			await sequelize.query(index.sql, { transaction });
		}
		await transaction.commit();
	} catch (error) {
		await transaction.rollback();
		throw error;
	} finally {
		await sequelize.query('PRAGMA foreign_keys = ON');
	}

	log.info(`Rebuilt ItemOrders without the bookmark type constraint.`);
};

const rewriteItemOrderTypes = async (sequelize, QueryTypes) => {
	if (!await tableExists(sequelize, QueryTypes, 'ItemOrders')) {
		log.info(`No ItemOrders table found. Skipping type rewrite.`);
		return;
	}

	const [table] = await sequelize.query(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ItemOrders'`,
		{ type: QueryTypes.SELECT }
	);
	if (/CHECK[^)]*'bookmark'/i.test(table?.sql ?? '')) {
		await rebuildItemOrders(sequelize, QueryTypes, table.sql);
	}

	await sequelize.query(`UPDATE \`ItemOrders\` SET type = 'shortcut' WHERE type = 'bookmark'`);
	const [pending] = await sequelize.query(
		`SELECT COUNT(*) AS total FROM \`ItemOrders\` WHERE type = 'bookmark'`,
		{ type: QueryTypes.SELECT }
	);
	if ((pending?.total ?? 0) > 0) {
		throw new Error(`${pending.total} ItemOrders rows still carry the bookmark type.`);
	}

	log.info(`Rewrote the ItemOrders bookmark rows to shortcut.`);
};

const moveIcons = async () => {
	if (!await exists(OLD_ICONS_DIR)) {
		log.info(`No bookmark icons directory found. Skipping icons move.`);
		return;
	}

	await fs.mkdir(path.dirname(NEW_ICONS_DIR), { recursive: true });
	await fs.rename(OLD_ICONS_DIR, NEW_ICONS_DIR);
	log.info(`Moved ${OLD_ICONS_DIR} -> ${NEW_ICONS_DIR}`);
};

const renameBookmarksToShortcuts = async () => {
	try {
		if (await exists(NEW_ICONS_DIR)) {
			log.info(`${NEW_ICONS_DIR} already exists. Skipping the bookmark to shortcut rename.`);
			return;
		}

		if (!await exists(DATABASE_FILE)) {
			log.info(`No database file found. Skipping the bookmark to shortcut rename.`);
			await moveIcons();
			return;
		}

		const { sequelize } = await import('../database/index.js');
		const { QueryTypes } = await import('sequelize');

		await renameShortcutsTable(sequelize, QueryTypes);
		await rewriteItemOrderTypes(sequelize, QueryTypes);
		await moveIcons();

		log.info(`Bookmarks renamed to shortcuts successfully!`);
	} catch (error) {
		log.error(`Bookmark to shortcut rename failed:`, error);
	}
};

if (isMainModule) {
	renameBookmarksToShortcuts();
}

export default renameBookmarksToShortcuts;
