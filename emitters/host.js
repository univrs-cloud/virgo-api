const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { Sequelize, DataTypes } = require('sequelize');
const si = require('systeminformation');
const { zfs } = require('zfs');
const { I2C } = require('raspi-i2c');

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

let i2c;
try {
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

module.exports = (io) => {
	let timeoutIds = {};
	const getCpu = () => {
		Promise.all([
			si.currentLoad(),
			si.cpuTemperature(),
			exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true')
		])
			.then(([currentLoad, cpuTemperature, fan]) => {
				io.emit('cpu', { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') });
				timeoutIds.cpu = setTimeout(getCpu, 3000);
			});
	};

	const getMemory = () => {
		si.mem()
			.then((memory) => {
				io.emit('memory', memory);
				timeoutIds.memory = setTimeout(getMemory, 5000);
			});
	};

	const getFilesystem = () => {
		Promise.all([
			si.fsSize(),
			new Promise((resolve, reject) => {
				zfs.list((error, datasets) => {
					if (error) {
						return reject(error);
					}

					resolve(datasets);
				});
			})
		])
			.then(([filesystem, datasets]) => {
				filesystem.map((fs) => {
					if (fs.type === 'zfs') {
						let dataset = datasets.find((dataset) => {
							return dataset.name === fs.fs;
						});
						fs.used = dataset.used;
						fs.available = dataset.avail;
						fs.size = dataset.used + dataset.avail;
						fs.use = dataset.used * 100 / (dataset.used + dataset.avail);
					}
					return fs;
				});
				io.emit('filesystem', filesystem);
				timeoutIds.filesystem = setTimeout(getFilesystem, 60000);
			});
	};

	const getNetwork = () => {
		si.networkStats()
			.then((interfaces) => {
				io.emit('network', interfaces[0]);
				timeoutIds.network = setTimeout(getNetwork, 2000);
			});
	};

	const getUps = () => {
		if (!i2c) {
			io.emit('ups', 'remote i/o error');
			return;
		}

		let powerSource = '';
		try {
			powerSource = fs.readFileSync('/tmp/ups_power_source', 'utf8');
		} catch (error) {
			io.emit('ups', error.message);
			return;
		}

		io.emit('ups', {
			batteryCharge: i2c.readByteSync(0x36, 4),
			powerSource: powerSource
		});
		timeoutIds.ups = setTimeout(getUps, 60000);
	};

	const getTime = () => {
		io.emit('time', si.time());
		timeoutIds.time = setTimeout(getTime, 10000);
	};
	
	io.on('connection', (socket) => {
		getCpu();
		getMemory();
		getFilesystem();
		getNetwork();
		getUps();
		getTime();

		socket.on('disconnect', () => {
			if (io.engine.clientsCount === 0) {
				Object.entries(timeoutIds).map((timeoutId) => { clearTimeout(timeoutId); });
				timeoutIds = {};
			}
		});
	});
};
