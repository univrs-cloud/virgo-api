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

export { sequelize };
