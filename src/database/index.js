const { Sequelize } = require('sequelize');
const fs = require('fs');

// Check if the target directory exists, fallback to old location if not
let dbPath = '/messier/.config/virgo.db';
try {
	fs.accessSync('/messier/.config');
} catch (error) {
	// ZFS pool not mounted, use fallback location
	dbPath = '/var/www/virgo-api/virgo.db';
}

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: dbPath,
	logging: false
});

module.exports = { sequelize };
