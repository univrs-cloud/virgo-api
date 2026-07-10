import fs from 'fs';
import { Sequelize } from 'sequelize';

// Check if the target directory exists, fallback to old location if not
let dbPath = '/messier/.config/virgo.db';
if (!fs.existsSync(dbPath)) {
	dbPath = '/var/www/virgo-api/virgo.db';
}

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: dbPath,
	logging: false
});

await sequelize.query('PRAGMA journal_mode = WAL;');
await sequelize.query('PRAGMA busy_timeout = 5000;');
await sequelize.query('PRAGMA synchronous = NORMAL;');

export { sequelize };
