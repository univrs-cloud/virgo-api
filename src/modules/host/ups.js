let i2c;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

const checkUps = async (plugin) => {
	if (i2c === false) {
		plugin.setState('ups', 'remote i/o error');
		plugin.getNsp().emit('host:ups', plugin.getState('ups'));
		return;
	}

	if (plugin.getState('ups') === undefined) {
		plugin.setState('ups', {});
	}

	let batteryCharge;
	try {
		batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		batteryCharge = false;
	}
	plugin.setState('ups', { ...plugin.getState('ups'), batteryCharge });
	
	plugin.getNsp().emit('host:ups', plugin.getState('ups'));
};

module.exports = {
	name: 'ups',
	register(plugin) {
		checkUps(plugin);
		
		if (i2c !== false) {
			plugin.addJobSchedule(
				'ups:check',
				{ pattern: '0 */10 * * * *' }
			);
		}
	},
	onConnection(socket, plugin) {
		if (plugin.getState('ups')) {
			socket.emit('host:ups', plugin.getState('ups'));
		}
	},
	jobs: {
		'ups:check': async (job, plugin) => {
			checkUps(plugin);
			return  '';
		}
	}
};
