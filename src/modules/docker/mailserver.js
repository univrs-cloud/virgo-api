import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { execa } from 'execa';

const APP_NAME = 'mailserver';
const DEFAULT_SELECTOR = 'dms';
const UNMAPPED_SELECTOR = 'mail';
const DKIM_RECORD_SUFFIX = '.public.dns.txt';
const DKIM_KEY_SUFFIXES = ['.private', '.public.txt', DKIM_RECORD_SUFFIX];
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const QUOTA_UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
let pendingLoad = null;

const configDir = (module) => {
	return path.join(module.appsDir, APP_NAME, 'config');
};

const findMailContainer = (module) => {
	return module.toArray(module.getState('containers')).find((container) => {
		return String(container.labels?.comDockerComposeProject ?? '').toLowerCase() === APP_NAME && String(container.labels?.comDockerComposeService ?? '').toLowerCase() === APP_NAME && container.state === 'running';
	});
};

const requireMailContainer = (module) => {
	const container = findMailContainer(module);
	if (!container) {
		throw new Error('MailServer is not running. Start it and try again.');
	}

	return container;
};

const exec = async (container, args, input) => {
	return await execa('docker', ['exec', ...(input === undefined ? [] : ['-i']), container.id, ...args], { reject: false, ...(input === undefined ? {} : { input }) });
};

const setup = async (container, args, input, failure) => {
	const { exitCode } = await exec(container, ['setup', ...args], input);
	if (exitCode !== 0) {
		throw new Error(failure);
	}
};

const readLines = async (file) => {
	try {
		return (await fs.readFile(file, 'utf-8')).split('\n').map((line) => { return line.trim(); }).filter((line) => { return line !== '' && !line.startsWith('#'); });
	} catch (error) {
		return [];
	}
};

const domainOf = (address) => {
	return String(address).split('@').pop().toLowerCase();
};

const toBytes = (quota) => {
	const match = /^(\d+)([bkmgt])?$/i.exec(String(quota ?? '').trim());
	if (!match) {
		return null;
	}

	return Number(match[1]) * QUOTA_UNITS[(match[2] ?? 'b').toLowerCase()];
};

const normalizeEmail = (value) => {
	const email = String(value ?? '').trim().toLowerCase();
	const [localPart, domain, ...rest] = email.split('@');
	if (rest.length > 0 || !LOCAL_PART_PATTERN.test(localPart ?? '') || !DOMAIN_PATTERN.test(domain ?? '')) {
		throw new Error('Enter a valid email address.');
	}

	return email;
};

const normalizeDomain = (value) => {
	const domain = String(value ?? '').trim().toLowerCase();
	if (!DOMAIN_PATTERN.test(domain)) {
		throw new Error('Enter a valid domain.');
	}

	return domain;
};

const normalizePassword = (value) => {
	const password = String(value ?? '');
	if (password.length < 8 || /[\r\n]/.test(password)) {
		throw new Error('Use a password of at least 8 characters, on one line.');
	}

	return password;
};

const normalizeIp = (value) => {
	const ip = String(value ?? '').trim().toLowerCase();
	if (net.isIP(ip) === 0) {
		throw new Error('Enter a valid IP address.');
	}

	return ip;
};

const readSelectors = async (module) => {
	const selectors = {};
	for (const line of await readLines(path.join(configDir(module), 'rspamd', 'dkim_selectors.map'))) {
		const [domain, selector] = line.split(/\s+/);
		if (domain && selector) {
			selectors[domain.toLowerCase()] = selector;
		}
	}
	return selectors;
};

const readDkim = async (module) => {
	const dkimDir = path.join(configDir(module), 'rspamd', 'dkim');
	const selectors = await readSelectors(module);
	let files = [];
	try {
		files = await fs.readdir(dkimDir);
	} catch (error) {
		return {};
	}

	const unmappedSuffix = `-${UNMAPPED_SELECTOR}${DKIM_RECORD_SUFFIX}`;
	const domains = new Set([
		...Object.keys(selectors),
		...files.filter((file) => { return file.toLowerCase().endsWith(unmappedSuffix); }).map((file) => { return file.slice(0, -unmappedSuffix.length).toLowerCase(); })
	]);
	const keys = {};
	for (const domain of domains) {
		const selector = (selectors[domain] ?? UNMAPPED_SELECTOR);
		try {
			keys[domain] = { selector, record: (await fs.readFile(path.join(dkimDir, `${domain}-${selector}${DKIM_RECORD_SUFFIX}`), 'utf-8')).trim() };
		} catch (error) {
			continue;
		}
	}
	return keys;
};

const readDefaultDomain = async (module) => {
	try {
		const env = await fs.readFile(path.join(module.appsDir, APP_NAME, module.composeDir, '.env'), 'utf-8');
		const domain = String(/^MX_DOMAIN="?([^"\n]*)"?$/m.exec(env)?.[1] ?? '').trim().toLowerCase();
		return (DOMAIN_PATTERN.test(domain) ? domain : null);
	} catch (error) {
		return null;
	}
};

const readDefaultLimit = async (module) => {
	try {
		const compose = await fs.readFile(module.projectComposeFile(APP_NAME), 'utf-8');
		const bytes = /POSTFIX_MAILBOX_SIZE_LIMIT=(\d+)/.exec(compose)?.[1];
		return (bytes === undefined ? 0 : Math.floor(Number(bytes) / 1000000) * 1024 * 1024);
	} catch (error) {
		return null;
	}
};

const readUsage = async (container) => {
	const usage = {};
	if (!container) {
		return usage;
	}

	const { stdout, exitCode } = await exec(container, ['doveadm', '-f', 'tab', 'quota', 'get', '-A']);
	if (exitCode !== 0) {
		return usage;
	}

	for (const line of String(stdout).split('\n').slice(1)) {
		const [username, , type, value, limit] = line.split('\t');
		if (String(type ?? '').toUpperCase() !== 'STORAGE' || !username) {
			continue;
		}

		usage[username.toLowerCase()] = {
			used: (/^\d+$/.test(value ?? '') ? Number(value) * 1024 : null),
			limit: (/^\d+$/.test(limit ?? '') ? Number(limit) * 1024 : null)
		};
	}
	return usage;
};

const BAN_LINE_PATTERN = /^(\S+)\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+ (-?\d+) = /;

const readBans = async (container) => {
	if (!container) {
		return [];
	}

	const [{ stdout, exitCode }, clock] = await Promise.all([
		exec(container, ['fail2ban-client', 'status']),
		exec(container, ['date', '+%z'])
	]);
	if (exitCode !== 0) {
		return [];
	}

	const offset = (/^([+-]\d{2})(\d{2})$/.exec(String(clock.stdout).trim()) ?? [null, '+00', '00']).slice(1).join(':');
	const jails = (/Jail list:\s*(.*)$/m.exec(stdout)?.[1] ?? '').split(',').map((jail) => { return jail.trim(); }).filter(Boolean);
	const bans = new Map();
	for (const jail of jails) {
		const list = await exec(container, ['fail2ban-client', 'get', jail, 'banip', '--with-time']);
		for (const line of String(list.stdout).split('\n')) {
			const match = BAN_LINE_PATTERN.exec(line.trim());
			if (!match) {
				continue;
			}

			const [, ip, date, time, duration] = match;
			const since = new Date(`${date}T${time}${offset}`).getTime();
			const until = (Number(duration) < 0 ? null : since + Number(duration) * 1000);
			const ban = bans.get(ip) ?? { ip, jails: [], since, until };
			ban.jails = [...ban.jails, jail];
			ban.since = Math.min(ban.since, since);
			ban.until = (ban.until === null || until === null ? null : Math.max(ban.until, until));
			bans.set(ip, ban);
		}
	}
	return [...bans.values()];
};

const loadState = async (module) => {
	if (!pendingLoad) {
		pendingLoad = (async () => {
			const container = findMailContainer(module);
			const dir = configDir(module);
			const [accountLines, aliasLines, quotaLines, dkim, usage, bans, defaultDomain, defaultLimit] = await Promise.all([
				readLines(path.join(dir, 'postfix-accounts.cf')),
				readLines(path.join(dir, 'postfix-virtual.cf')),
				readLines(path.join(dir, 'dovecot-quotas.cf')),
				readDkim(module),
				readUsage(container),
				readBans(container),
				readDefaultDomain(module),
				readDefaultLimit(module)
			]);
			const quotas = {};
			for (const line of quotaLines) {
				const [email, quota] = line.split(':');
				if (email) {
					quotas[email.toLowerCase()] = toBytes(quota);
				}
			}

			const accounts = accountLines.map((line) => {
				const email = line.split('|')[0].toLowerCase();
				return { email, quota: (Object.hasOwn(quotas, email) ? quotas[email] : null), limit: (usage[email]?.limit ?? null), used: (usage[email]?.used ?? null) };
			});
			const aliases = aliasLines.filter((line) => { return !line.startsWith('/'); }).map((line) => {
				const [address, ...rest] = line.split(/\s+/);
				return { address: address.toLowerCase(), recipients: rest.join('').split(',').map((recipient) => { return recipient.trim().toLowerCase(); }).filter(Boolean) };
			});
			const names = new Set([...Object.keys(dkim), ...accounts.map((account) => { return domainOf(account.email); }), ...aliases.map((alias) => { return domainOf(alias.address); })]);
			const domains = [...names].map((name) => {
				return {
					name,
					dkim: (dkim[name] ?? null),
					accounts: accounts.filter((account) => { return domainOf(account.email) === name; }).length,
					aliases: aliases.filter((alias) => { return domainOf(alias.address) === name; }).length
				};
			});
			module.setState('mailserver', { isRunning: Boolean(container), defaultDomain, defaultLimit, domains, accounts, aliases, bans });
			module.emitState('mailserver');
		})().finally(() => {
			pendingLoad = null;
		});
	}
	return await pendingLoad;
};

const removeKeyFiles = async (module, domain, selectors) => {
	for (const selector of selectors) {
		for (const suffix of DKIM_KEY_SUFFIXES) {
			await fs.rm(path.join(configDir(module), 'rspamd', 'dkim', `${domain}-${selector}${suffix}`), { force: true });
		}
	}
};

const createDkimKey = async (module, container, domain, isReplacing) => {
	await setup(container, ['config', 'dkim', 'domain', domain, 'selector', DEFAULT_SELECTOR, ...(isReplacing ? ['--force'] : [])], undefined, `Could not create ${(isReplacing ? 'a new' : 'the')} DKIM key for ${domain}. Try again later.`);
};

const removeDkimKey = async (module, domain) => {
	const rspamdDir = path.join(configDir(module), 'rspamd');
	const mapped = (await readSelectors(module))[domain];
	await removeKeyFiles(module, domain, [mapped ?? UNMAPPED_SELECTOR]);

	const mapFile = path.join(rspamdDir, 'dkim_selectors.map');
	let stats;
	let content;
	try {
		[stats, content] = await Promise.all([fs.stat(mapFile), fs.readFile(mapFile, 'utf-8')]);
	} catch (error) {
		return;
	}

	const lines = content.split('\n').filter((line) => { return line.trim().split(/\s+/)[0]?.toLowerCase() !== domain; });
	await fs.writeFile(mapFile, lines.join('\n'), 'utf-8');
	await fs.chown(mapFile, stats.uid, stats.gid);
};

const toQuotaArgument = (quota) => {
	if (quota === undefined || quota === 'default') {
		return null;
	}

	if (quota === 'unlimited') {
		return '0';
	}

	if (!Number.isInteger(quota) || quota < 1) {
		throw new Error('Enter a storage limit of at least 1 GiB.');
	}

	return `${quota}G`;
};

const requireKnownDomain = async (module, email) => {
	await loadState(module);
	const domain = domainOf(email);
	if (!module.toArray(module.getState('mailserver')?.domains).some((item) => { return item.name === domain; })) {
		throw new Error(`Add the domain ${domain} first.`);
	}
};

const run = async (job, module, task) => {
	return await module.withAppLock(APP_NAME, async () => {
		try {
			return await task(job.data?.config ?? {});
		} finally {
			await loadState(module).catch((error) => { console.error('MailServer state:', error); });
		}
	});
};

const addDomain = async (job, module) => {
	return await run(job, module, async (config) => {
		const domain = normalizeDomain(config.domain);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Adding ${domain}...`);
		if (!(await readDkim(module))[domain]) {
			await createDkimKey(module, container, domain, false);
		}
		return `${domain} added.`;
	});
};

const removeDomain = async (job, module) => {
	return await run(job, module, async (config) => {
		const domain = normalizeDomain(config.domain);
		await loadState(module);
		const entry = module.toArray(module.getState('mailserver')?.domains).find((item) => { return item.name === domain; });
		if (entry && (entry.accounts > 0 || entry.aliases > 0)) {
			throw new Error(`Remove the accounts and aliases of ${domain} first.`);
		}

		await module.updateJobProgress(job, `Removing ${domain}...`);
		await removeDkimKey(module, domain);
		return `${domain} removed.`;
	});
};

const regenerateDkim = async (job, module) => {
	return await run(job, module, async (config) => {
		const domain = normalizeDomain(config.domain);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Creating a new DKIM key for ${domain}...`);
		await createDkimKey(module, container, domain, true);
		return `New DKIM key created for ${domain}. Update its DNS record.`;
	});
};

const addAccount = async (job, module) => {
	return await run(job, module, async (config) => {
		const email = normalizeEmail(config.email);
		const password = normalizePassword(config.password);
		const quota = toQuotaArgument(config.quota);
		const container = requireMailContainer(module);
		await requireKnownDomain(module, email);
		const state = module.getState('mailserver');
		if (module.toArray(state?.accounts).some((account) => { return account.email === email; })) {
			throw new Error(`${email} is already an account.`);
		}
		if (module.toArray(state?.aliases).some((alias) => { return alias.address === email; })) {
			throw new Error(`${email} is already an alias. Remove the alias first.`);
		}
		await module.updateJobProgress(job, `Adding ${email}...`);
		await setup(container, ['email', 'add', email], `${password}\n${password}\n`, `Could not add ${email}. Make sure it does not exist yet.`);
		if (quota) {
			await setup(container, ['quota', 'set', email, quota], undefined, `${email} was added, but its storage limit could not be set.`);
		}
		return `${email} added.`;
	});
};

const removeAccount = async (job, module) => {
	return await run(job, module, async (config) => {
		const email = normalizeEmail(config.email);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Removing ${email}...`);
		await setup(container, ['email', 'del', '-y', email], undefined, `Could not remove ${email}. Try again later.`);
		return `${email} removed.`;
	});
};

const changePassword = async (job, module) => {
	return await run(job, module, async (config) => {
		const email = normalizeEmail(config.email);
		const password = normalizePassword(config.password);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Changing the password of ${email}...`);
		await setup(container, ['email', 'update', email], `${password}\n${password}\n`, `Could not change the password of ${email}. Try again later.`);
		return `Password of ${email} changed.`;
	});
};

const setQuota = async (job, module) => {
	return await run(job, module, async (config) => {
		const email = normalizeEmail(config.email);
		const quota = toQuotaArgument(config.quota);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Setting the storage limit of ${email}...`);
		if (quota) {
			await setup(container, ['quota', 'set', email, quota], undefined, `Could not set the storage limit of ${email}. Try again later.`);
		} else {
			await setup(container, ['quota', 'del', email], undefined, `Could not reset the storage limit of ${email}. Try again later.`);
		}
		return `Storage limit of ${email} updated.`;
	});
};

const addAlias = async (job, module) => {
	return await run(job, module, async (config) => {
		const address = normalizeEmail(config.address);
		const recipient = normalizeEmail(config.recipient);
		const container = requireMailContainer(module);
		await requireKnownDomain(module, address);
		const state = module.getState('mailserver');
		if (module.toArray(state?.accounts).some((account) => { return account.email === address; })) {
			throw new Error(`${address} is already an account.`);
		}
		if (module.toArray(state?.aliases).some((alias) => { return alias.address === address && alias.recipients.includes(recipient); })) {
			throw new Error(`${address} is already an alias of ${recipient}.`);
		}
		if (!module.toArray(state?.accounts).some((account) => { return account.email === recipient; })) {
			throw new Error(`${recipient} is not an account on this mail server.`);
		}
		await module.updateJobProgress(job, `Adding ${address}...`);
		await setup(container, ['alias', 'add', address, recipient], undefined, `Could not add ${address}. Try again later.`);
		return `${address} now forwards to ${recipient}.`;
	});
};

const removeAlias = async (job, module) => {
	return await run(job, module, async (config) => {
		const address = normalizeEmail(config.address);
		const recipient = normalizeEmail(config.recipient);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Removing ${address}...`);
		await setup(container, ['alias', 'del', address, recipient], undefined, `Could not remove ${address}. Try again later.`);
		return `${address} no longer forwards to ${recipient}.`;
	});
};

const banIp = async (job, module) => {
	return await run(job, module, async (config) => {
		const ip = normalizeIp(config.ip);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Blocking ${ip}...`);
		await setup(container, ['fail2ban', 'ban', ip], undefined, `Could not block ${ip}. It may already be blocked.`);
		return `${ip} blocked.`;
	});
};

const unbanIp = async (job, module) => {
	return await run(job, module, async (config) => {
		const ip = normalizeIp(config.ip);
		const container = requireMailContainer(module);
		await module.updateJobProgress(job, `Unblocking ${ip}...`);
		await setup(container, ['fail2ban', 'unban', ip], undefined, `Could not unblock ${ip}. Try again later.`);
		return `${ip} unblocked.`;
	});
};

const register = (module) => {
	module.declareState({
		mailserver: { event: 'app:mailserver', audience: 'admin', gated: true }
	});
};

export default {
	name: 'mailserver',
	register,
	commands: {
		'app:mailserver:fetch': {
			handler: async (config, socket, module) => {
				await loadState(module);
				return { status: 'succeeded' };
			}
		},
		'app:mailserver:domain:add': { job: 'app:mailserver:domain:add' },
		'app:mailserver:domain:remove': { job: 'app:mailserver:domain:remove' },
		'app:mailserver:dkim:regenerate': { job: 'app:mailserver:dkim:regenerate' },
		'app:mailserver:account:add': { job: 'app:mailserver:account:add' },
		'app:mailserver:account:remove': { job: 'app:mailserver:account:remove' },
		'app:mailserver:account:password': { job: 'app:mailserver:account:password' },
		'app:mailserver:account:quota': { job: 'app:mailserver:account:quota' },
		'app:mailserver:alias:add': { job: 'app:mailserver:alias:add' },
		'app:mailserver:alias:remove': { job: 'app:mailserver:alias:remove' },
		'app:mailserver:ban:add': { job: 'app:mailserver:ban:add' },
		'app:mailserver:ban:remove': { job: 'app:mailserver:ban:remove' }
	},
	jobs: {
		'app:mailserver:domain:add': addDomain,
		'app:mailserver:domain:remove': removeDomain,
		'app:mailserver:dkim:regenerate': regenerateDkim,
		'app:mailserver:account:add': addAccount,
		'app:mailserver:account:remove': removeAccount,
		'app:mailserver:account:password': changePassword,
		'app:mailserver:account:quota': setQuota,
		'app:mailserver:alias:add': addAlias,
		'app:mailserver:alias:remove': removeAlias,
		'app:mailserver:ban:add': banIp,
		'app:mailserver:ban:remove': unbanIp
	}
};
