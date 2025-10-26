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
	module.getNsp().to(`user:${socket.username}`).emit('host:updates:check', module.getState('checkUpdates'));
	try {
		await execa('apt', ['update', '--allow-releaseinfo-change']);
		module.setState('checkUpdates', false);
		module.updates(socket);
	} catch (error) {
		module.setState('checkUpdates', false);
		module.getNsp().to(`user:${socket.username}`).emit('host:updates:check', module.getState('checkUpdates'));
	}
};

const upgrade = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (module.upgradePid !== null) {
		return;
	}

	module.setState('upgrade', {
		state: 'running',
		steps: []
	});
	
	const watcherPlugin = module.getPlugin('watcher');
	if (watcherPlugin) {
		watcherPlugin.watchUpgradeLog(module);
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
			`"echo $$ > ${module.upgradePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove 2>&1 | tee -a ${module.upgradeFile}"`
		], { shell: true });
		await module.checkUpgrade(socket);
	} catch (error) {
		const watcherPlugin = module.getPlugin('watcher');
		if (watcherPlugin && watcherPlugin.upgradeLogsWatcher) {
			await watcherPlugin.upgradeLogsWatcher.stop();
			watcherPlugin.upgradeLogsWatcher = undefined;
		}
		clearInterval(module.checkUpgradeIntervalId);
		module.checkUpgradeIntervalId = null;
		module.setState('upgrade', { ...module.getState('upgrade'), state: 'failed' });
		module.getNsp().emit('host:upgrade', module.getState('upgrade'));
		module.updates(socket);
	}
};

const completeUpgrade = (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}
	
	module.setState('upgrade', undefined);
	module.upgradePid = null;
	fs.closeSync(fs.openSync(module.upgradePidFile, 'w'));
	fs.closeSync(fs.openSync(module.upgradeFile, 'w'));
	module.getNsp().emit('host:upgrade', null);
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

	module.getNsp().emit('host:reboot', module.getState('reboot'));
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

	module.getNsp().emit('host:shutdown', module.getState('shutdown'));
};

module.exports = {
	name: 'system_actions',
	onConnection(socket, module) {
		socket.on('host:updates:check', () => { 
			checkUpdates(socket, module); 
		});
		socket.on('host:upgrade', () => { 
			upgrade(socket, module); 
		});
		socket.on('host:upgrade:complete', () => { 
			completeUpgrade(socket, module); 
		});
		socket.on('host:reboot', () => { 
			reboot(socket, module); 
		});
		socket.on('host:shutdown', () => { 
			shutdown(socket, module); 
		});
	}
};
