import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { Sequelize } from 'sequelize';

const STATS_DATABASE_FILE = '/messier/.config/stats.db';
const READ = sqlite3.OPEN_READWRITE;
const READ_WRITE_CREATE = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

let opened = false;
let opening = null;

const hasPool = () => {
	return fs.existsSync(path.dirname(STATS_DATABASE_FILE));
};

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: STATS_DATABASE_FILE,
	dialectOptions: { mode: (hasPool() ? READ_WRITE_CREATE : READ) },
	logging: false
});

const open = async () => {
	sequelize.options.dialectOptions.mode = READ_WRITE_CREATE;
	sequelize.connectionManager.connections = {};
	sequelize.connectionManager.initPools();
	await sequelize.query('PRAGMA journal_mode = WAL;');
	await sequelize.query('PRAGMA busy_timeout = 5000;');
	await sequelize.query('PRAGMA synchronous = NORMAL;');
	opened = true;
};

const ensureOpen = async () => {
	if (opened) {
		return true;
	}

	if (!hasPool()) {
		return false;
	}

	opening = opening ?? (async () => {
		try {
			await open();
		} catch (error) {
			console.error('Unable to open the stats database on the pool:', error);
		} finally {
			opening = null;
		}
	})();
	await opening;
	return opened;
};

export { sequelize, ensureOpen };
