import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const Session = sequelize.define('Session', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	hash: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	username: {
		type: DataTypes.STRING,
		allowNull: false
	},
	ipAddress: {
		type: DataTypes.STRING,
		allowNull: true
	},
	userAgent: {
		type: DataTypes.TEXT,
		allowNull: true
	},
	lastSeenAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
});

export default Session;
