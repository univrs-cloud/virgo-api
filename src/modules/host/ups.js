const i2c = require('i2c-bus');
let bus;
try {
	bus = i2c.openSync(1);
} catch (error) {
	bus = false;
}

const checkUps = async (module) => {
	if (bus === false) {
		module.setState('ups', 'remote i/o error');
		module.getNsp().emit('host:ups', module.getState('ups'));
		return;
	}

	if (module.getState('ups') === undefined) {
		module.setState('ups', {});
	}

	let batteryCharge;
	try {
		batteryCharge = bus.readByteSync(0x36, 0x04);
	} catch (error) {
		batteryCharge = false;
	}
	module.setState('ups', { ...module.getState('ups'), batteryCharge });
	
	module.getNsp().emit('host:ups', module.getState('ups'));
};

module.exports = {
	name: 'ups',
	register(module) {
		checkUps(module);
		
		if (bus !== false) {
			module.addJobSchedule(
				'ups:check',
				{ pattern: '0 */10 * * * *' }
			);
		}
	},
	onConnection(socket, module) {
		if (module.getState('ups')) {
			socket.emit('host:ups', module.getState('ups'));
		}
	},
	jobs: {
		'ups:check': async (job, module) => {
			checkUps(module);
			return  '';
		}
	}
};
