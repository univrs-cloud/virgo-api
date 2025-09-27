const { Sequelize } = require('sequelize');

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '/var/www/virgo-api/virgo.db',
	logging: false // Set to console.log to see SQL queries
});

module.exports = { sequelize };
