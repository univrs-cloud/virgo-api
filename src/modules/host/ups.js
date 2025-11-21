let i2c;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

const checkUps = async (module) => {
	if (i2c === false) {
		module.setState('ups', 'remote i/o error');
		module.nsp.emit('host:ups', module.getState('ups'));
		return;
	}

	if (module.getState('ups') === undefined) {
		module.setState('ups', {});
	}

	let batteryCharge;
	try {
		batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		batteryCharge = false;
	}
	module.setState('ups', { ...module.getState('ups'), batteryCharge });
	
	module.nsp.emit('host:ups', module.getState('ups'));
};

const register = (module) => {
	checkUps(module);
	
	if (i2c !== false) {
		module.addJobSchedule(
			'ups:check',
			{ pattern: '0 */10 * * * *' }
		);
	}
};

const onConnection = (socket, module) => {
	if (module.getState('ups')) {
		socket.emit('host:ups', module.getState('ups'));
	}
};

module.exports = {
	name: 'ups',
	register,
	onConnection,
	jobs: {
		'ups:check': async (job, module) => {
			checkUps(module);
			return  '';
		}
	}
};
