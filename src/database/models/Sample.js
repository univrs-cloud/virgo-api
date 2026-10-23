import { DataTypes } from 'sequelize';
import { sequelize } from '../stats.js';

const Sample = sequelize.define('Sample', {
	time: {
		type: DataTypes.INTEGER,
		primaryKey: true
	},
	cpu: {
		type: DataTypes.FLOAT,
		allowNull: false
	},
	memory: {
		type: DataTypes.INTEGER,
		allowNull: false
	},
	rx: {
		type: DataTypes.FLOAT,
		allowNull: false
	},
	tx: {
		type: DataTypes.FLOAT,
		allowNull: false
	}
}, {
	timestamps: false
});

export default Sample;
