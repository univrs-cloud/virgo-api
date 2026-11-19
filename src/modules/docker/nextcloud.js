import { promises as fs } from 'fs';
import path from 'path';
import { execa } from 'execa';

const APP_NAME = 'nextcloud';
const APP_ID_PATTERN = /^[a-z0-9_]+$/;
const UPDATE_LINE_PATTERN = /^(\S+) new version available: (\S+)$/;
const FAILED_LINE_PATTERN = /(couldn't be updated$|^Error:)/;
const INFO_CONCURRENCY = 4;
let pendingCheck = null;
let pendingAccountsLoad = null;

const findNextcloudContainer = (module) => {
	return module.toArray(module.getState('containers')).find((container) => {
		return String(container.labels?.comDockerComposeProject ?? '').toLowerCase() === APP_NAME && String(container.labels?.comDockerComposeService ?? '').toLowerCase() === APP_NAME && container.state === 'running';
	});
};

const OCC_USER = 'abc';
const OCC_PATH = '/app/www/public/occ';

const occ = async (container, args, password) => {
	const passwordArgs = (password === undefined ? [] : ['--env', 'OC_PASS']);
	return await execa('docker', ['exec', ...passwordArgs, '--user', OCC_USER, container.id, 'php', OCC_PATH, ...args], { reject: false, ...(password === undefined ? {} : { env: { OC_PASS: password } }) });
};

const occJson = async (container, args) => {
	const { stdout, exitCode } = await occ(container, [...args, '--output=json']);
	if (exitCode !== 0) {
		return null;
	}

	try {
		return JSON.parse(stdout);
	} catch (error) {
		return null;
	}
};

const QUOTA_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const USER_ID_PATTERN = /^[a-z0-9_.@-]{1,64}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toBytes = (quota) => {
	const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b)?$/i.exec(String(quota ?? '').trim());
	return (match ? Math.round(Number(match[1]) * QUOTA_UNITS[(match[2] ?? 'b').toLowerCase()]) : null);
};

const readDefaultLimit = async (container) => {
	const { stdout, exitCode } = await occ(container, ['config:app:get', 'files', 'default_quota']);
	return (exitCode === 0 ? toBytes(stdout) : null);
};

const toDate = (value) => {
	const time = Date.parse(value);
	return (Number.isNaN(time) ? null : time);
};

const readStorage = async (container, ids) => {
	const storage = {};
	const queue = [...ids];
	const worker = async () => {
		while (queue.length > 0) {
			const id = queue.shift();
			const info = await occJson(container, ['user:info', id]);
			if (info?.storage) {
				storage[id] = info.storage;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(INFO_CONCURRENCY, ids.length) }, worker));
	return storage;
};

const readAccounts = async (container) => {
	const [users, groups, defaultLimit] = await Promise.all([
		occJson(container, ['user:list', '--info', '--limit=0']),
		occJson(container, ['group:list', '--info', '--limit=-1']),
		readDefaultLimit(container)
	]);
	if (!users || !groups) {
		return null;
	}

	const storage = await readStorage(container, Object.keys(users));
	return {
		defaultLimit,
		users: Object.entries(users).map(([id, user]) => {
			const quota = String(user?.quota ?? '').toLowerCase();
			const limit = storage[id]?.quota;
			return {
				id,
				displayName: user?.display_name || id,
				email: user?.email || null,
				enabled: user?.enabled !== false,
				groups: (Array.isArray(user?.groups) ? user.groups : []),
				isDefaultLimit: quota === 'default',
				limit: (typeof limit === 'number' && limit >= 0 ? limit : null),
				used: (typeof storage[id]?.used === 'number' ? storage[id].used : null),
				lastSeen: toDate(user?.last_seen)
			};
		}),
		groups: Object.entries(groups).map(([id, group]) => {
			return {
				id,
				displayName: group?.displayName || id,
				users: (Array.isArray(group?.users) ? group.users : [])
			};
		})
	};
};

const loadAccounts = async (module) => {
	if (!pendingAccountsLoad) {
		pendingAccountsLoad = (async () => {
			const container = findNextcloudContainer(module);
			const accounts = (container ? await readAccounts(container) : null);
			module.setState('nextcloudAccounts', { isRunning: Boolean(container), isReadable: Boolean(accounts), defaultLimit: accounts?.defaultLimit ?? null, users: accounts?.users ?? [], groups: accounts?.groups ?? [] });
			module.emitState('nextcloudAccounts');
		})().finally(() => {
			pendingAccountsLoad = null;
		});
	}
	return await pendingAccountsLoad;
};

const ADMIN_GROUP = 'admin';

const changeGroupMembership = async (job, module, isAdding) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const accounts = module.getState('nextcloudAccounts');
			const user = module.toArray(accounts?.users).find((item) => { return item.id === job.data?.config?.user; });
			const group = module.toArray(accounts?.groups).find((item) => { return item.id === job.data?.config?.group; });
			if (!user || !group) {
				throw new Error('This user or group no longer exists. Open the list again.');
			}

			if (!isAdding && group.id === ADMIN_GROUP && group.users.length === 1 && group.users.includes(user.id)) {
				throw new Error('Nextcloud needs at least one administrator.');
			}

			await module.updateJobProgress(job, `${(isAdding ? 'Adding' : 'Removing')} ${user.displayName} ${(isAdding ? 'to' : 'from')} ${group.displayName}...`);
			const { exitCode } = await occ(container, [(isAdding ? 'group:adduser' : 'group:removeuser'), group.id, user.id]);
			if (exitCode !== 0) {
				throw new Error(`Could not ${(isAdding ? 'add' : 'remove')} ${user.displayName} ${(isAdding ? 'to' : 'from')} ${group.displayName}. Try again later.`);
			}

			return `${user.displayName} ${(isAdding ? 'added to' : 'removed from')} ${group.displayName}.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const addUser = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const config = job.data?.config ?? {};
			const id = String(config.user ?? '').trim();
			const displayName = String(config.displayName ?? '').trim();
			const email = String(config.email ?? '').trim();
			const password = String(config.password ?? '');
			const groupIds = (Array.isArray(config.groups) ? config.groups : []);
			if (!USER_ID_PATTERN.test(id)) {
				throw new Error('Use a username of up to 64 letters, digits, dots, dashes, underscores or @.');
			}
			if (displayName === '' || displayName.length > 64 || /[\r\n]/.test(displayName)) {
				throw new Error('Enter a name of up to 64 characters.');
			}
			if (!EMAIL_PATTERN.test(email)) {
				throw new Error('Enter a valid email address.');
			}
			if (password.length < 8 || /[\r\n]/.test(password)) {
				throw new Error('Use a password of at least 8 characters, on one line.');
			}
			if (config.quota !== 'default' && (!Number.isInteger(config.quota) || config.quota < 1)) {
				throw new Error('Enter a storage limit of at least 1 GiB.');
			}

			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const accounts = module.getState('nextcloudAccounts');
			if (module.toArray(accounts?.users).some((user) => { return user.id.toLowerCase() === id.toLowerCase(); })) {
				throw new Error(`An account named ${id} already exists.`);
			}
			const knownGroups = module.toArray(accounts?.groups).map((group) => { return group.id; });
			if (groupIds.some((groupId) => { return !knownGroups.includes(groupId); })) {
				throw new Error('One of the chosen groups no longer exists. Open the list again.');
			}

			const name = displayName;
			await module.updateJobProgress(job, `Adding ${name}...`);
			const { exitCode } = await occ(container, [
				'user:add',
				'--password-from-env',
				`--display-name=${displayName}`,
				`--email=${email}`,
				...groupIds.map((groupId) => { return `--group=${groupId}`; }),
				id
			], password);
			if (exitCode !== 0) {
				throw new Error(`Could not add ${name}. Try again later.`);
			}

			if (config.quota !== 'default') {
				const quota = await occ(container, ['user:setting', id, 'files', 'quota', `${config.quota} GB`]);
				if (quota.exitCode !== 0) {
					throw new Error(`${name} was added, but its storage limit could not be set.`);
				}
			}

			return `${name} added.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const editUser = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const config = job.data?.config ?? {};
			const displayName = String(config.displayName ?? '').trim();
			const email = String(config.email ?? '').trim();
			if (displayName === '' || displayName.length > 64 || /[\r\n]/.test(displayName)) {
				throw new Error('Enter a name of up to 64 characters.');
			}
			if (!EMAIL_PATTERN.test(email)) {
				throw new Error('Enter a valid email address.');
			}
			if (config.quota !== 'default' && (!Number.isInteger(config.quota) || config.quota < 1)) {
				throw new Error('Enter a storage limit of at least 1 GiB.');
			}

			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const user = module.toArray(module.getState('nextcloudAccounts')?.users).find((item) => { return item.id === config.user; });
			if (!user) {
				throw new Error('This account no longer exists. Open the list again.');
			}

			await module.updateJobProgress(job, `Saving ${displayName}...`);
			const changes = [
				...(displayName !== user.displayName ? [['settings', 'display_name', displayName]] : []),
				...(email.toLowerCase() !== String(user.email ?? '').toLowerCase() ? [['settings', 'email', email]] : []),
				...(config.quota === 'default' ? (user.isDefaultLimit ? [] : [['files', 'quota', 'default']]) : [['files', 'quota', `${config.quota} GB`]])
			];
			for (const [app, key, value] of changes) {
				const { exitCode } = await occ(container, ['user:setting', user.id, app, key, value]);
				if (exitCode !== 0) {
					throw new Error(`Could not save all changes to ${displayName}. Try again later.`);
				}
			}

			return `${displayName} saved.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const changeUserPassword = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		const password = String(job.data?.config?.password ?? '');
		if (password.length < 8 || /[\r\n]/.test(password)) {
			throw new Error('Use a password of at least 8 characters, on one line.');
		}

		const container = findNextcloudContainer(module);
		if (!container) {
			throw new Error('Nextcloud is not running. Start it and try again.');
		}

		await loadAccounts(module);
		const user = module.toArray(module.getState('nextcloudAccounts')?.users).find((item) => { return item.id === job.data?.config?.user; });
		if (!user) {
			throw new Error('This account no longer exists. Open the list again.');
		}

		await module.updateJobProgress(job, `Changing the password of ${user.displayName}...`);
		const { exitCode } = await occ(container, ['user:resetpassword', '--password-from-env', user.id], password);
		if (exitCode !== 0) {
			throw new Error(`Could not change the password of ${user.displayName}. Try again later.`);
		}

		return `Password of ${user.displayName} changed.`;
	});
};

const setUserEnabled = async (job, module, isEnabling) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const accounts = module.getState('nextcloudAccounts');
			const user = module.toArray(accounts?.users).find((item) => { return item.id === job.data?.config?.user; });
			if (!user) {
				throw new Error('This account no longer exists. Open the list again.');
			}

			const adminGroup = module.toArray(accounts?.groups).find((group) => { return group.id === ADMIN_GROUP; });
			if (!isEnabling && adminGroup?.users.length === 1 && adminGroup.users.includes(user.id)) {
				throw new Error('Nextcloud needs at least one administrator. Make another account an administrator first.');
			}

			await module.updateJobProgress(job, `${(isEnabling ? 'Unlocking' : 'Locking')} ${user.displayName}...`);
			const { exitCode } = await occ(container, [(isEnabling ? 'user:enable' : 'user:disable'), user.id]);
			if (exitCode !== 0) {
				throw new Error(`Could not ${(isEnabling ? 'unlock' : 'lock')} ${user.displayName}. Try again later.`);
			}

			return `${user.displayName} ${(isEnabling ? 'unlocked' : 'locked')}.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const deleteUser = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const accounts = module.getState('nextcloudAccounts');
			const users = module.toArray(accounts?.users);
			const user = users.find((item) => { return item.id === job.data?.config?.user; });
			if (!user) {
				throw new Error('This account no longer exists. Open the list again.');
			}

			const adminGroup = module.toArray(accounts?.groups).find((group) => { return group.id === ADMIN_GROUP; });
			if (adminGroup?.users.length === 1 && adminGroup.users.includes(user.id)) {
				throw new Error('Nextcloud needs at least one administrator. Make another account an administrator first.');
			}

			const transferTo = job.data?.config?.transferTo;
			if (transferTo) {
				const receiver = users.find((item) => { return item.id === transferTo && item.id !== user.id; });
				if (!receiver) {
					throw new Error('The account chosen to receive the files no longer exists. Open the list again.');
				}

				await module.updateJobProgress(job, `Giving the files of ${user.displayName} to ${receiver.displayName}...`);
				const { stdout, stderr, exitCode } = await occ(container, ['files:transfer-ownership', user.id, receiver.id]);
				if (exitCode !== 0) {
					if (/enough free space/i.test(`${stdout}\n${stderr}`)) {
						throw new Error(`${receiver.displayName} does not have enough storage space for the files of ${user.displayName}. Raise their storage limit and try again.`);
					}
					throw new Error(`Could not give the files of ${user.displayName} to ${receiver.displayName}, so the account was not deleted. Try again later.`);
				}
			}

			await module.updateJobProgress(job, `Deleting ${user.displayName}...`);
			const { exitCode } = await occ(container, ['user:delete', user.id]);
			if (exitCode !== 0) {
				throw new Error(`Could not delete ${user.displayName}. Try again later.`);
			}

			return `${user.displayName} deleted.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const addGroup = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const name = String(job.data?.config?.group ?? '').trim();
			if (name === '' || name.length > 64 || /[\r\n]/.test(name)) {
				throw new Error('Enter a group name of up to 64 characters.');
			}

			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			if (module.toArray(module.getState('nextcloudAccounts')?.groups).some((group) => { return group.id.toLowerCase() === name.toLowerCase() || group.displayName.toLowerCase() === name.toLowerCase(); })) {
				throw new Error(`A group named ${name} already exists.`);
			}

			await module.updateJobProgress(job, `Adding the group ${name}...`);
			const { exitCode } = await occ(container, ['group:add', name, `--display-name=${name}`]);
			if (exitCode !== 0) {
				throw new Error(`Could not add the group ${name}. Try again later.`);
			}

			return `Group ${name} added.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
};

const deleteGroup = async (job, module) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			const container = findNextcloudContainer(module);
			if (!container) {
				throw new Error('Nextcloud is not running. Start it and try again.');
			}

			await loadAccounts(module);
			const group = module.toArray(module.getState('nextcloudAccounts')?.groups).find((item) => { return item.id === job.data?.config?.group; });
			if (!group) {
				throw new Error('This group no longer exists. Open the list again.');
			}

			if (group.id === ADMIN_GROUP) {
				throw new Error('The admin group cannot be deleted.');
			}

			await module.updateJobProgress(job, `Deleting the group ${group.displayName}...`);
			const { exitCode } = await occ(container, ['group:delete', group.id]);
			if (exitCode !== 0) {
				throw new Error(`Could not delete the group ${group.displayName}. Try again later.`);
			}

			return `Group ${group.displayName} deleted.`;
		} finally {
			await loadAccounts(module).catch((error) => { console.error('Nextcloud accounts:', error); });
		}
	});
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

const getChangelogs = async (module) => {
	const dataDir = path.join(module.appsDir, APP_NAME, 'data');
	let catalogues = [];
	try {
		const entries = await fs.readdir(dataDir);
		catalogues = await Promise.all(entries.filter((entry) => { return entry.toLowerCase().startsWith('appdata_'); }).map(async (entry) => {
			const file = path.join(dataDir, entry, 'appstore', 'apps.json');
			try {
				return { file, modifiedAt: (await fs.stat(file)).mtimeMs };
			} catch (error) {
				return null;
			}
		}));
	} catch (error) {
		return {};
	}

	const [latest] = catalogues.filter(Boolean).sort((first, second) => { return second.modifiedAt - first.modifiedAt; });
	if (!latest) {
		return {};
	}

	try {
		const { data } = JSON.parse(await fs.readFile(latest.file, 'utf-8'));
		const changelogs = {};
		for (const app of module.toArray(data)) {
			for (const release of module.toArray(app?.releases)) {
				const changelog = release?.translations?.en?.changelog;
				if (typeof changelog === 'string' && changelog.trim() !== '') {
					changelogs[`${app.id}@${release.version}`] = changelog.trim();
				}
			}
		}
		return changelogs;
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
			const changelogs = (updates.length > 0 ? await getChangelogs(module) : {});
			module.setState('nextcloudAppUpdates', updates.map(([, id, version]) => {
				return { id, version, currentVersion: (typeof installedVersions[id] === 'string' ? installedVersions[id] : null), changelog: (changelogs[`${id}@${version}`] ?? null) };
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
		nextcloudAppUpdates: { event: 'app:nextcloud:updates', audience: 'admin', gated: true },
		nextcloudAccounts: { event: 'app:nextcloud:accounts', audience: 'admin', gated: true }
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
		'app:nextcloud:update': { job: 'app:nextcloud:update' },
		'app:nextcloud:user:add': { job: 'app:nextcloud:user:add' },
		'app:nextcloud:user:edit': { job: 'app:nextcloud:user:edit' },
		'app:nextcloud:user:password': { job: 'app:nextcloud:user:password' },
		'app:nextcloud:user:enable': { job: 'app:nextcloud:user:enable' },
		'app:nextcloud:user:disable': { job: 'app:nextcloud:user:disable' },
		'app:nextcloud:user:delete': { job: 'app:nextcloud:user:delete' },
		'app:nextcloud:group:add': { job: 'app:nextcloud:group:add' },
		'app:nextcloud:group:delete': { job: 'app:nextcloud:group:delete' },
		'app:nextcloud:group:adduser': { job: 'app:nextcloud:group:adduser' },
		'app:nextcloud:group:removeuser': { job: 'app:nextcloud:group:removeuser' },
		'app:nextcloud:accounts:fetch': {
			handler: async (config, socket, module) => {
				await loadAccounts(module);
				return { status: 'succeeded' };
			}
		}
	},
	jobs: {
		'app:nextcloud:updates:check': (job, module) => {
			return checkApps(job, module);
		},
		'app:nextcloud:user:add': (job, module) => {
			return addUser(job, module);
		},
		'app:nextcloud:user:password': (job, module) => {
			return changeUserPassword(job, module);
		},
		'app:nextcloud:user:edit': (job, module) => {
			return editUser(job, module);
		},
		'app:nextcloud:user:enable': (job, module) => {
			return setUserEnabled(job, module, true);
		},
		'app:nextcloud:user:disable': (job, module) => {
			return setUserEnabled(job, module, false);
		},
		'app:nextcloud:user:delete': (job, module) => {
			return deleteUser(job, module);
		},
		'app:nextcloud:group:add': (job, module) => {
			return addGroup(job, module);
		},
		'app:nextcloud:group:delete': (job, module) => {
			return deleteGroup(job, module);
		},
		'app:nextcloud:group:adduser': (job, module) => {
			return changeGroupMembership(job, module, true);
		},
		'app:nextcloud:group:removeuser': (job, module) => {
			return changeGroupMembership(job, module, false);
		},
		'app:nextcloud:update': (job, module) => {
			return module.withAppLock(APP_NAME, async () => {
				return await updateApps(job, module);
			});
		}
	}
};
