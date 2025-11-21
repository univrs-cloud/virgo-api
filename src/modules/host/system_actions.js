const fs = require('fs');
const { execa } = require('execa');

const checkUpdates = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.getState('checkUpdates')) {
		return;
	}

	module.setState('checkUpdates', true);
	module.nsp.to(`user:${socket.username}`).emit('host:updates:check', module.getState('checkUpdates'));
	try {
		await execa('apt', ['update', '--allow-releaseinfo-change']);
		module.setState('checkUpdates', false);
		module.checkForUpdates();
	} catch (error) {
		module.setState('checkUpdates', false);
		module.nsp.to(`user:${socket.username}`).emit('host:updates:check', module.getState('checkUpdates'));
	}
};

const update = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.updatePid !== null) {
		return;
	}

	module.setState('update', {
		state: 'running',
		steps: []
	});
	
	let updateLogsWatcher;
	const watcherPlugin = module.getPlugin('watcher');
	if (watcherPlugin) {
		updateLogsWatcher = await watcherPlugin.watchUpdateLog(module);
	}

	try {
		await execa('systemd-run', [
			'--unit=upgrade-system',
			'--description="System upgrade"',
			'--wait',
			'--collect',
			'--setenv=DEBIAN_FRONTEND=noninteractive',
			'bash',
			'-c',
			`"echo $$ > ${module.updatePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove 2>&1 | tee -a ${module.updatFile}"`
		], { shell: true });
		await module.checkUpdate();
	} catch (error) {
		console.log(error);
		clearInterval(module.checkUpdateIntervalId);
		module.checkUpdateIntervalId = null;
		await updateLogsWatcher?.stop();
		module.setState('update', { ...module.getState('update'), state: 'failed' });
		module.nsp.emit('host:update', module.getState('update'));
		module.checkForUpdates();
	}
};

const completeUpdate = (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}
	
	fs.closeSync(fs.openSync(module.updatePidFile, 'w'));
	fs.closeSync(fs.openSync(module.updatFile, 'w'));
	module.updatePid = null;
	module.setState('update', undefined);
	module.nsp.emit('host:update', module.getState('update'));
};

const reboot = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.getState('reboot') !== undefined) {
		return;
	}

	try {
		await execa('reboot');
		module.setState('reboot', true);
	} catch (error) {
		module.setState('reboot', false);
	}

	module.nsp.emit('host:reboot', module.getState('reboot'));
};

const shutdown = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.getState('shutdown') !== undefined) {
		return;
	}

	try {
		await execa('shutdown', ['-h', 'now']);
		module.setState('shutdown', true);
	} catch (error) {
		module.setState('shutdown', false);
	}

	module.nsp.emit('host:shutdown', module.getState('shutdown'));
};

const onConnection = (socket, module) => {
	socket.on('host:updates:check', () => { 
		checkUpdates(socket, module); 
	});
	socket.on('host:update', () => { 
		update(socket, module); 
	});
	socket.on('host:update:complete', () => { 
		completeUpdate(socket, module); 
	});
	socket.on('host:reboot', () => { 
		reboot(socket, module); 
	});
	socket.on('host:shutdown', () => { 
		shutdown(socket, module); 
	});
};

module.exports = {
	name: 'system_actions',
	onConnection
};
