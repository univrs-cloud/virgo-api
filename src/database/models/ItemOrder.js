import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const ItemOrder = sequelize.define('ItemOrder', {
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

export default ItemOrder;

