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
	for (const socket of module.nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('host:updates:check', module.getState('checkUpdates'));
		}
	}
	try {
		await execa('apt', ['update', '--allow-releaseinfo-change']);
		await module.generateUpdates();
	} catch (error) {
	}
	module.setState('checkUpdates', false);
	for (const socket of module.nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('host:updates:check', module.getState('checkUpdates'));
		}
	}
};

const update = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.updatePid !== null) {
		return;
	}

	let updateLogsWatcher;
	const watcherPlugin = module.getPlugin('watcher');
	if (watcherPlugin) {
		updateLogsWatcher = await watcherPlugin.watchUpdateLog(module);
	}

	module.setState('update', {
		steps: [],
		state: 'running'
	});

	try {
		await execa('systemd-run', [
			'--unit=system-update',
			'--description="System update"',
			'--wait',
			'--collect',
			'--setenv=DEBIAN_FRONTEND=noninteractive',
			'bash',
			'-c',
			`"echo $$ > ${module.updatePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove 2>&1 | tee -a ${module.updateFile}; echo $? > ${module.updateExitStatusFile}"`
		], { shell: true });
	} catch (error) {
		console.error(error.message);
	}
	await module.checkUpdate();
};

const completeUpdate = (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}
	
	fs.closeSync(fs.openSync(module.updateExitStatusFile, 'w'));
	fs.closeSync(fs.openSync(module.updatePidFile, 'w'));
	fs.closeSync(fs.openSync(module.updateFile, 'w'));
	module.updatePid = null;
	module.setState('update', undefined);
	module.nsp.emit('host:update', module.getState('update'));
};

const onConnection = (socket, module) => {
	if (module.getState('updates')) {
		socket.emit('host:updates', (socket.isAuthenticated && socket.isAdmin ? module.getState('updates') : []));
	}
	if (socket.isAuthenticated && socket.isAdmin) {
		if (module.getState('checkUpdates')) {
			socket.emit('host:updates:check', module.getState('checkUpdates'));
		}
	}

	socket.on('host:updates:check', () => { 
		checkUpdates(socket, module); 
	});
	socket.on('host:update', () => { 
		update(socket, module); 
	});
	socket.on('host:update:complete', () => { 
		completeUpdate(socket, module); 
	});
};

module.exports = {
	name: 'update',
	onConnection
};
