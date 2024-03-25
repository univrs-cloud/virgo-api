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
	},
	updates: () => {
		return exec('apt-show-versions -u')
			.then((response) => {
				let lines = response.stdout.trim().split('\n');
				lines = lines.map((line) => {
					let parts = line.split(' ');
					return {
						package: parts[0].split(':')[0],
						version: {
							installed: parts[1].split('~')[0],
							upgradableTo: parts[4].split('~')[0]
						}
					};
				});
				return lines;
			});
	}
};

module.exports = host;
