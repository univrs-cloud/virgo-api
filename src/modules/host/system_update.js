import fs from 'fs';
import { execa } from 'execa';

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

	if (await module.isUpdateInProgress()) {
		return;
	}

	module.resetUpdateTracking();

	let updateLogsWatcher;
	const watcherPlugin = module.getPlugin('watcher');
	if (watcherPlugin) {
		updateLogsWatcher = await watcherPlugin.watchUpdateLog(module);
	}

	module.setState('update', {
		steps: [],
		state: 'running'
	});
	module.emitUpdateState();

	try {
		// Passed to bash -c directly (no shell: true) so /bin/sh never sees bash-only syntax.
		const updateScript = [
			`echo $BASHPID > ${module.updatePidFile}`,
			'UPDATE_EXIT=1',
			`trap 'echo "$UPDATE_EXIT" > ${module.updateExitStatusFile}' EXIT`,
			'set -o pipefail',
			`apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove 2>&1 | tee -a ${module.updateFile}`,
			'UPDATE_EXIT=$?',
		].join('\n');
		await execa('systemd-run', [
			'--unit=system-update',
			'--description=System update',
			'--wait',
			'--collect',
			'--setenv=DEBIAN_FRONTEND=noninteractive',
			'bash',
			'-c',
			updateScript,
		]);
	} catch (error) {
		console.error(error.message);
	}
	await module.checkUpdate();
};

const completeUpdate = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	module.resetUpdateTracking();
	for (const file of [module.updateExitStatusFile, module.updatePidFile, module.updateFile]) {
		await fs.promises.writeFile(file, '');
	}
	module.setState('update', null);
	module.emitUpdateState();
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
	socket.on('host:update:complete', async () => { 
		await completeUpdate(socket, module); 
	});
};

export default {
	name: 'system_update',
	onConnection
};
