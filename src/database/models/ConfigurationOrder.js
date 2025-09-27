const { DataTypes } = require('sequelize');
const { sequelize } = require('../index');

const ConfigurationOrder = sequelize.define('ConfigurationOrder', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	itemId: {
		type: DataTypes.INTEGER,
		allowNull: false
	},
	type: {
		type: DataTypes.ENUM('app', 'bookmark'),
		allowNull: false
	},
	order: {
		type: DataTypes.INTEGER,
		allowNull: false
	}
}, {
	indexes: [
		{
			unique: true,
			fields: ['itemId', 'type']
		}
	]
});

module.exports = ConfigurationOrder;
