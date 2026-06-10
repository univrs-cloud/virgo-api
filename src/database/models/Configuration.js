import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

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

export default Configuration;
