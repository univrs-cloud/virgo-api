import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { Sequelize } from 'sequelize';

const POOL_DATABASE_FILE = '/messier/.config/virgo.db';
// Without OPEN_CREATE sqlite will not bring the file into existence, and sequelize will not create
// the directory leading to it either — so a node with no pool writes no database to the system disk.
const READ = sqlite3.OPEN_READWRITE;
const READ_WRITE_CREATE = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

const hasPool = () => {
	return fs.existsSync(path.dirname(POOL_DATABASE_FILE));
};

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: POOL_DATABASE_FILE,
	dialectOptions: { mode: (hasPool() ? READ_WRITE_CREATE : READ) },
	logging: false
});

/** Opens the database on the pool, whether it is there at boot or prepared later. Connections made
 * before the pool existed failed and are left behind by their pool, so both are rebuilt — otherwise
 * the first query afterwards waits on a connection that will never come. */
const open = async () => {
	sequelize.options.dialectOptions.mode = READ_WRITE_CREATE;
	sequelize.connectionManager.connections = {};
	sequelize.connectionManager.initPools();
	await sequelize.query('PRAGMA journal_mode = WAL;');
	await sequelize.query('PRAGMA busy_timeout = 5000;');
	await sequelize.query('PRAGMA synchronous = NORMAL;');
};

if (hasPool()) {
	await open();
}

export { sequelize, open };
