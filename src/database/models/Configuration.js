const { DataTypes } = require('sequelize');
const { sequelize } = require('../index');

const Configuration = sequelize.define('Configuration', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	key: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	value: {
		type: DataTypes.TEXT,
		allowNull: false
	}
}, {
	timestamps: false
});

module.exports = Configuration;
