import fs from 'fs/promises';
import { execa } from 'execa';

const checkUpdates = async (socket, module) => {
	if (module.getState('checkUpdates')) {
		return;
	}

	module.setState('checkUpdates', true);
	module.emitState('checkUpdates');
	try {
		await execa('apt', ['update', '--allow-releaseinfo-change']);
		await module.generateUpdates();
	} catch (error) {
	}
	module.setState('checkUpdates', false);
	module.emitState('checkUpdates');
};

const update = async (socket, module) => {
	if (await module.isUpdateInProgress()) {
		return;
	}

	module.resetUpdateTracking();

	let updateLogsWatcher;
	const watcher = module.getPlugin('watcher');
	if (watcher) {
		updateLogsWatcher = await watcher?.watchUpdateLog(module);
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
			`apt-get dist-upgrade -y -q -o APT::Status-Fd=3 -o Dpkg::Options::='--force-confold' --auto-remove 3>>${module.updateProgressFile} 2>&1 | tee -a ${module.updateFile}`,
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
	module.resetUpdateTracking();
	for (const file of [module.updateExitStatusFile, module.updatePidFile, module.updateFile, module.updateProgressFile]) {
		await fs.writeFile(file, '');
	}
	module.setState('update', null);
	module.emitUpdateState();
};

const register = (module) => {
	module.declareState({
		checkUpdates: { event: 'host:updates:check', audience: 'admin' }
	});
};

export default {
	name: 'system_update',
	register,
	commands: {
		'host:updates:check': { handler: (config, socket, module) => { return checkUpdates(socket, module); } },
		'host:update': { handler: (config, socket, module) => { return update(socket, module); } },
		'host:update:complete': { handler: (config, socket, module) => { return completeUpdate(socket, module); } }
	}
};
