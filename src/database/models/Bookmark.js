const { DataTypes } = require('sequelize');
const { sequelize } = require('../index');

const Bookmark = sequelize.define('Bookmark', {
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
	},
	url: {
		type: DataTypes.TEXT,
		allowNull: true
	},
	order: {
		type: DataTypes.INTEGER,
		allowNull: false,
		defaultValue: 0
	}
});

module.exports = Bookmark;
