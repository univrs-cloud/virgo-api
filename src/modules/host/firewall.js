import fs from 'fs/promises';
import { execa } from 'execa';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const SERVICES_FILE = '/etc/services';
const PORT_NAMES = {
	2999: 'ACME hook',
	3000: 'virgoOS API',
	3477: 'TURN',
	3478: 'STUN',
	5355: 'LLMNR',
	6881: 'qBittorrent',
	51820: 'WireGuard',
	'61000:61500': 'TURN relay'
};
const PROTOCOL_NAMES = {
	icmp: 'Ping'
};

const optionValue = (tokens, ...options) => {
	const index = tokens.findIndex((token) => { return options.includes(token); });
	return (index === -1 ? null : tokens[index + 1] ?? null);
};

const loadServiceNames = async () => {
	const serviceNames = new Map();
	try {
		const content = await fs.readFile(SERVICES_FILE, 'utf8');
		const services = [];
		const descriptions = new Map();
		for (const line of content.split('\n')) {
			const [definition, ...comment] = line.split('#');
			const [name, port] = definition.trim().split(/\s+/);
			if (!name || !port) {
				continue;
			}

			const description = comment.join('#').replace(/\[[^\]]*\]/g, '').trim();
			if (description && !descriptions.has(name)) {
				descriptions.set(name, description);
			}
			services.push({ name, port: port.toLowerCase() });
		}
		for (const { name, port } of services) {
			if (!serviceNames.has(port)) {
				serviceNames.set(port, descriptions.get(name) || name);
			}
		}
	} catch (error) {
		console.error('loadServiceNames:', error);
	}
	return serviceNames;
};

const loadRules = async () => {
	const [{ stdout }, serviceNames] = await Promise.all([
		execa('iptables', ['-S', 'INPUT']),
		loadServiceNames()
	]);
	const lines = stdout.split('\n').map((line) => { return line.trim(); }).filter(Boolean);
	const policy = lines.find((line) => { return line.startsWith('-P INPUT '); })?.split(/\s+/)[2]?.toLowerCase() || null;
	const rules = [];
	for (const line of lines) {
		const tokens = line.match(/"[^"]*"|\S+/g) || [];
		const protocol = optionValue(tokens, '-p')?.toLowerCase();
		if (tokens[0] !== '-A' || !protocol || optionValue(tokens, '-j')?.toLowerCase() !== 'accept') {
			continue;
		}

		const ports = (optionValue(tokens, '--dport', '--dports') || '').split(',').filter(Boolean);
		rules.push({
			protocol,
			ports,
			source: optionValue(tokens, '-s'),
			name: (ports.length === 1 ? serviceNames.get(`${ports[0]}/${protocol}`) || PORT_NAMES[ports[0]] : PROTOCOL_NAMES[protocol]) || null
		});
	}
	return { policy, rules };
};

const toUnixTime = (value) => {
	const time = Math.floor(new Date(value.replace(' ', 'T')).getTime() / 1000);
	return (Number.isNaN(time) ? null : time);
};

const loadBans = async (jail, addresses) => {
	try {
		const { stdout } = await execa('fail2ban-client', ['get', jail, 'banip', '--with-time']);
		return stdout.split('\n').map((line) => { return line.trim(); }).filter(Boolean).map((line) => {
			const [, address, bannedAt, banTime, expiresAt] = line.match(/^(\S+)\s+(\S+ \S+) \+ (-?\d+) = (\S+ \S+)$/) || [null, line.split(/\s+/)[0]];
			return {
				address,
				bannedAt: (bannedAt ? toUnixTime(bannedAt) : null),
				expiresAt: (expiresAt && Number(banTime) >= 0 && !expiresAt.startsWith('9999-') ? toUnixTime(expiresAt) : null),
				permanent: Boolean(expiresAt) && (Number(banTime) < 0 || expiresAt.startsWith('9999-'))
			};
		});
	} catch (error) {
		console.error('loadBans:', error);
		return addresses.map((address) => { return { address, bannedAt: null, expiresAt: null, permanent: false }; });
	}
};

const loadJails = async () => {
	const { stdout } = await execa('fail2ban-client', ['status']);
	const names = (stdout.match(/Jail list:\s*(.*)$/m)?.[1] || '').split(',').map((name) => { return name.trim(); }).filter(Boolean);
	return Promise.all(names.map(async (name) => {
		const { stdout: status } = await execa('fail2ban-client', ['status', name]);
		const read = (label) => { return status.match(new RegExp(`${label}:[ \\t]*(.*)$`, 'm'))?.[1].trim() || ''; };
		return {
			name,
			currentlyFailed: Number(read('Currently failed')) || 0,
			totalFailed: Number(read('Total failed')) || 0,
			currentlyBanned: Number(read('Currently banned')) || 0,
			totalBanned: Number(read('Total banned')) || 0,
			bans: await loadBans(name, read('Banned IP list').split(/\s+/).filter(Boolean))
		};
	}));
};

const loadFirewall = async (module) => {
	const [filter, jails] = await Promise.all([
		loadRules().catch((error) => {
			console.error('loadRules:', error);
			return { policy: null, rules: false };
		}),
		loadJails().catch((error) => {
			console.error('loadJails:', error);
			return false;
		})
	]);
	module.setState('firewall', { ...filter, jails });
};

const broadcastFirewall = async (module) => {
	await loadFirewall(module);
	module.emitState('firewall');
};

const unbanAddress = async (job, module) => {
	const { config } = job.data;
	const jail = module.toArray(module.getState('firewall')?.jails).find((jail) => { return jail.name === config?.jail; });
	if (!jail?.bans.some((ban) => { return ban.address === config?.address; })) {
		throw new Error(`${config?.address} is not blocked.`);
	}

	await module.updateJobProgress(job, `${config.address} is unblocking...`);
	await execa('fail2ban-client', ['set', jail.name, 'unbanip', config.address]);
	await broadcastFirewall(module);
	return `${config.address} unblocked.`;
};

const register = (module) => {
	module.declareState({
		firewall: { event: 'host:firewall', audience: 'admin' }
	});
};

export default {
	name: 'firewall',
	commands: {
		'host:firewall:fetch': { handler: (config, socket, module) => { return broadcastFirewall(module); } },
		'host:firewall:unban': { job: 'host:firewall:unban' }
	},
	register,
	jobs: {
		'host:firewall:unban': unbanAddress
	},
	pollers: [
		{ run: broadcastFirewall, interval: REFRESH_INTERVAL_MS, audience: 'admin' }
	]
};
