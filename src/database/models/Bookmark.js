import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

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
	}
});

export default Bookmark;
