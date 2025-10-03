const fs = require('fs');
const { execa } = require('execa');

const checkUpdates = async (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (plugin.getState('checkUpdates')) {
		return;
	}

	plugin.setState('checkUpdates', true);
	plugin.getNsp().to(`user:${socket.username}`).emit('host:updates:check', plugin.getState('checkUpdates'));
	try {
		await execa('apt', ['update', '--allow-releaseinfo-change']);
		plugin.setState('checkUpdates', false);
		updates(socket, plugin);
	} catch (error) {
		plugin.setState('checkUpdates', false);
		plugin.getNsp().to(`user:${socket.username}`).emit('host:updates:check', plugin.getState('checkUpdates'));
	}
};

const upgrade = async (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (plugin.upgradePid !== null) {
		return;
	}

	plugin.setState('upgrade', {
		state: 'running',
		steps: []
	});
	
	const watcherPlugin = plugin.getPlugin('watcher');
	if (watcherPlugin) {
		watcherPlugin.watchUpgradeLog(plugin);
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
			`"echo $$ > ${plugin.upgradePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove 2>&1 | tee -a ${plugin.upgradeFile}"`
		], { shell: true });
		await plugin.checkUpgrade(socket);
	} catch (error) {
		const watcherPlugin = plugin.getPlugin('watcher');
		if (watcherPlugin && watcherPlugin.upgradeLogsWatcher) {
			await watcherPlugin.upgradeLogsWatcher.stop();
			watcherPlugin.upgradeLogsWatcher = undefined;
		}
		clearInterval(plugin.checkUpgradeIntervalId);
		plugin.checkUpgradeIntervalId = null;
		plugin.setState('upgrade', { ...plugin.getState('upgrade'), state: 'failed' });
		plugin.getNsp().emit('host:upgrade', plugin.getState('upgrade'));
		updates(socket, plugin);
	}
};

const completeUpgrade = (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}
	
	plugin.setState('upgrade', undefined);
	plugin.upgradePid = null;
	fs.closeSync(fs.openSync(plugin.upgradePidFile, 'w'));
	fs.closeSync(fs.openSync(plugin.upgradeFile, 'w'));
	plugin.getNsp().emit('host:upgrade', null);
};

const reboot = async (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (plugin.getState('reboot') !== undefined) {
		return;
	}

	try {
		await execa('reboot');
		plugin.setState('reboot', true);
	} catch (error) {
		plugin.setState('reboot', false);
	}

	plugin.getNsp().emit('host:reboot', plugin.getState('reboot'));
};

const shutdown = async (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (plugin.getState('shutdown') !== undefined) {
		return;
	}

	try {
		await execa('shutdown', ['-h', 'now']);
		plugin.setState('shutdown', true);
	} catch (error) {
		plugin.setState('shutdown', false);
	}

	plugin.getNsp().emit('host:shutdown', plugin.getState('shutdown'));
};

const updates = (socket, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		plugin.getNsp().to(`user:${socket.username}`).emit('host:updates', false);
		return;
	}

	if (plugin.upgradePid === null) {
		plugin.getNsp().emit('host:upgrade', null);
	}
	plugin.checkForUpdates();
};

module.exports = {
	name: 'system_actions',
	onConnection(socket, plugin) {
		socket.on('host:updates:check', () => { 
			checkUpdates(socket, plugin); 
		});
		socket.on('host:upgrade', () => { 
			upgrade(socket, plugin); 
		});
		socket.on('host:upgrade:complete', () => { 
			completeUpgrade(socket, plugin); 
		});
		socket.on('host:reboot', () => { 
			reboot(socket, plugin); 
		});
		socket.on('host:shutdown', () => { 
			shutdown(socket, plugin); 
		});
	}
};
