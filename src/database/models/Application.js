const { DataTypes } = require('sequelize');
const { sequelize } = require('../index');

const Application = sequelize.define('Application', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	name: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	canBeRemoved: {
		type: DataTypes.BOOLEAN,
		allowNull: false,
		defaultValue: true
	},
	category: {
		type: DataTypes.STRING,
		allowNull: true
	},
	title: {
		type: DataTypes.STRING,
		allowNull: true
	},
	icon: {
		type: DataTypes.STRING,
		allowNull: true
	}
});

module.exports = Application;
