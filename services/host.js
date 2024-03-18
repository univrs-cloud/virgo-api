const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { Sequelize, DataTypes } = require('sequelize');
const si = require('systeminformation');

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '/portainer/Files/AppData/Config/nginx-proxy-manager/data/database.sqlite',
	define: {
		timestamps: false
	}
});
const ProxyHost = sequelize.define(
	'ProxyHost',
	{
		enabled: DataTypes.BOOLEAN,
		domainNames: DataTypes.JSON,
		sslForced: DataTypes.BOOLEAN,
		forwardScheme: DataTypes.STRING,
		forwardHost: DataTypes.STRING,
		forwardPort: DataTypes.INTEGER
	},
	{
		tableName: 'proxy_host',
		underscored: true
	}
);

let host = {
	proxies: () => {
		return ProxyHost.findAll();
	},
	system: () => {
		return si.system();
	}
};

module.exports = host;
