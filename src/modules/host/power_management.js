import { execa } from 'execa';

const register = (module) => {
	module.declareState({
		reboot: { event: 'host:reboot' },
		shutdown: { event: 'host:shutdown' }
	});
};

const reboot = async (socket, module) => {
	if (module.getState('reboot') !== undefined) {
		return;
	}

	module.setState('reboot', true);
	module.emitState('reboot');
	try {
		await execa('reboot');
	} catch (error) {
		module.setState('reboot', false);
		module.emitState('reboot');
	}
};

const shutdown = async (socket, module) => {
	if (module.getState('shutdown') !== undefined) {
		return;
	}

	module.setState('shutdown', true);
	module.emitState('shutdown');
	try {
		await execa('shutdown', ['-h', 'now']);
	} catch (error) {
		module.setState('shutdown', false);
		module.emitState('shutdown');
	}
};

export default {
	name: 'power_management',
	register,
	commands: {
		'host:reboot': { handler: (config, socket, module) => { return reboot(socket, module); } },
		'host:shutdown': { handler: (config, socket, module) => { return shutdown(socket, module); } }
	}
};
