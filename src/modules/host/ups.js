const { createConnection } = require('net');
const camelcaseKeys = require('camelcase-keys').default;

const checkUps = async (module) => {
	let socket = createConnection('/var/run/virgo-ups.sock');
	let buffer = '';
	socket.on('connect', () => {
		buffer = '';
	});
	socket.on('data', (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop();
		for (const line of lines) {
			if (line.trim()) {
				try {
					let status = JSON.parse(line);
					status = camelcaseKeys(status, { deep: true });
					module.setState('ups', status);
				} catch (error) {
					console.error('Parse error:', error.message);
					module.setState('ups', 'remote i/o error');
				}
			}
		}
		module.nsp.emit('host:ups', module.getState('ups'));
	});
	socket.on('close', () => {
		console.log('UPS socket disconnected, reconnecting in 5s...');
		socket = null;
		setTimeout(() => { checkUps(module); }, 5000);
	});
}

const register = (module) => {
	checkUps(module);
};

const onConnection = (socket, module) => {
	if (module.getState('ups')) {
		socket.emit('host:ups', module.getState('ups'));
	}
};

module.exports = {
	name: 'ups',
	register,
	onConnection
};
