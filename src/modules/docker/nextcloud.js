import { execa } from 'execa';

const APP_NAME = 'nextcloud';
const APP_ID_PATTERN = /^[a-z0-9_]+$/;
const UPDATE_LINE_PATTERN = /^(\S+) new version available: (\S+)$/;
const FAILED_LINE_PATTERN = /(couldn't be updated$|^Error:)/;
let pendingCheck = null;

const findNextcloudContainer = (module) => {
	return module.toArray(module.getState('containers')).find((container) => {
		return String(container.labels?.comDockerComposeProject ?? '').toLowerCase() === APP_NAME && String(container.labels?.comDockerComposeService ?? '').toLowerCase() === APP_NAME && container.state === 'running';
	});
};

const occ = async (container, args) => {
	return await execa('docker', ['exec', container.id, 'occ', ...args], { reject: false });
};

const toLines = (output) => {
	return String(output ?? '').split('\n').map((line) => { return line.trim(); }).filter(Boolean);
};

const getInstalledVersions = async (container) => {
	const { stdout, exitCode } = await occ(container, ['app:list', '--enabled', '--output=json']);
	if (exitCode !== 0) {
		return {};
	}

	try {
		return JSON.parse(stdout)?.enabled ?? {};
	} catch (error) {
		return {};
	}
};

const checkForUpdates = async (module, container) => {
	if (!pendingCheck) {
		pendingCheck = (async () => {
			const { stdout, exitCode } = await occ(container, ['app:update', '--showonly']);
			if (exitCode !== 0) {
				module.setState('nextcloudAppUpdates', false);
				module.emitState('nextcloudAppUpdates');
				module.eventEmitter.emit('app:updates:updated', module.getAppUpdatesSummary());
				return;
			}

			const updates = toLines(stdout).map((line) => { return UPDATE_LINE_PATTERN.exec(line); }).filter(Boolean);
			const installedVersions = (updates.length > 0 ? await getInstalledVersions(container) : {});
			module.setState('nextcloudAppUpdates', updates.map(([, id, version]) => {
				return { id, version, currentVersion: (typeof installedVersions[id] === 'string' ? installedVersions[id] : null) };
			}).sort((first, second) => { return first.id.localeCompare(second.id); }));
			module.emitState('nextcloudAppUpdates');
			module.eventEmitter.emit('app:updates:updated', module.getAppUpdatesSummary());
		})().finally(() => {
			pendingCheck = null;
		});
	}
	return await pendingCheck;
};

const checkApps = async (job, module) => {
	const container = findNextcloudContainer(module);
	if (!container) {
		throw new Error('Nextcloud is not running. Start it and try again.');
	}

	await module.updateJobProgress(job, `Checking Nextcloud apps for updates...`);
	await checkForUpdates(module, container);
	const updates = module.getState('nextcloudAppUpdates');
	if (!Array.isArray(updates)) {
		throw new Error('Could not check Nextcloud apps for updates. Try again later.');
	}

	return (updates.length > 0 ? `${updates.length} Nextcloud app ${(updates.length === 1 ? 'update' : 'updates')} available.` : `Nextcloud apps are up to date.`);
};

const updateApps = async (job, module) => {
	const app = job.data?.config?.app;
	const withContainers = (job.data?.config?.containers === true && app === undefined);
	if (app !== undefined && !APP_ID_PATTERN.test(String(app))) {
		throw new Error('This Nextcloud app could not be found.');
	}

	const container = findNextcloudContainer(module);
	if (!container && !withContainers) {
		throw new Error('Nextcloud is not running. Start it and try again.');
	}

	const title = (app ?? 'Nextcloud apps');
	let failed = [];
	if (container) {
		await module.updateJobProgress(job, `Updating ${title}...`);
		const { stdout, stderr } = await occ(container, ['app:update', ...(app ? [app] : ['--all'])]);
		failed = toLines(`${stdout}\n${stderr}`).filter((line) => { return FAILED_LINE_PATTERN.test(line); });
		await checkForUpdates(module, container);
	}

	if (withContainers) {
		await module.addJob('app:update', { config: { name: APP_NAME }, username: job.data?.username });
	}

	if (failed.length > 0) {
		throw new Error(`${(app ? `${app} could` : 'Some Nextcloud apps could')} not be updated. Try again later.`);
	}

	return (container ? `${title} updated.` : `Nextcloud is not running, so only Nextcloud itself is updated.`);
};

const register = (module) => {
	module.declareState({
		nextcloudAppUpdates: { event: 'app:nextcloud:updates', audience: 'admin', gated: true }
	});

	module.eventEmitter.on('app:containers:fetched', async () => {
		if (Array.isArray(module.getState('nextcloudAppUpdates'))) {
			return;
		}

		const container = findNextcloudContainer(module);
		if (!container) {
			return;
		}

		await checkForUpdates(module, container)
			.catch((error) => { console.error('Nextcloud app updates check:', error); });
	});

	module.addJobSchedule(
		'app:nextcloud:updates:check',
		{ pattern: '0 0 0 * * *' }
	);
};

export default {
	name: 'nextcloud',
	register,
	commands: {
		'app:nextcloud:updates:check': { job: 'app:nextcloud:updates:check' },
		'app:nextcloud:update': { job: 'app:nextcloud:update' }
	},
	jobs: {
		'app:nextcloud:updates:check': (job, module) => {
			return checkApps(job, module);
		},
		'app:nextcloud:update': (job, module) => {
			return module.withAppLock(APP_NAME, async () => {
				return await updateApps(job, module);
			});
		}
	}
};
