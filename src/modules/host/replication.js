import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';
import DataService from '../../database/data_service.js';
import { isNodeId } from '../../utils/node_id.js';
import { createLog } from '../../utils/log.js';

const log = createLog('host:replication');

const USER_NAME = 'virgo-replication';
const HOME_PATH = '/var/lib/virgo-replication';
const SHELL_PATH = '/bin/sh';
const AUTHORIZED_KEYS_PATH = path.join(HOME_PATH, '.ssh', 'authorized_keys');
const CLIENT_PATH = '/etc/virgo-replication';
const PRIVATE_KEY_PATH = path.join(CLIENT_PATH, 'id_ed25519');
const PUBLIC_KEY_PATH = `${PRIVATE_KEY_PATH}.pub`;
const KNOWN_HOSTS_PATH = path.join(CLIENT_PATH, 'known_hosts');
const SSH_CONFIG_PATH = path.join(CLIENT_PATH, 'ssh_config');
const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key.pub';
const POOL_PERMISSIONS = 'send,hold';
const KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/;
const ADDRESS_PATTERN = /^[0-9a-f.:]+$/i;
const SSH_TIMEOUT_SECONDS = 10;

let hostModule = null;
let syncing = false;
let syncAgain = false;
let lock = Promise.resolve();

const exclusive = (task) => {
	const run = lock.then(task);
	lock = run.catch(() => {});
	return run;
};

const prepareLocally = async (task) => {
	try {
		return await exclusive(task);
	} catch (error) {
		throw new Error('This node could not prepare its backups. Try again, or restart it if it keeps failing.', { cause: error });
	}
};

const readKey = async (filePath) => {
	const content = await fs.readFile(filePath, 'utf8').catch(() => { return ''; });
	const key = content.trim().split(/\s+/).slice(0, 2).join(' ');
	return (KEY_PATTERN.test(key) ? key : null);
};

const writeIfChanged = async (filePath, content, mode) => {
	const current = await fs.readFile(filePath, 'utf8').catch(() => { return null; });
	if (current !== content) {
		const temporary = `${filePath}.tmp`;
		await fs.writeFile(temporary, content, { encoding: 'utf8', mode });
		await fs.rename(temporary, filePath);
		log.info(`Updated ${filePath}.`);
	}

	await fs.chown(filePath, 0, 0);
	await fs.chmod(filePath, mode);
};

const ensureDirectory = async (directory, mode) => {
	await fs.mkdir(directory, { recursive: true });
	await fs.chown(directory, 0, 0);
	await fs.chmod(directory, mode);
};

const ensureUser = async () => {
	const { exitCode, stdout } = await execa('getent', ['passwd', USER_NAME], { reject: false });
	if (exitCode !== 0) {
		await execa('useradd', ['--system', '--home-dir', HOME_PATH, '--shell', SHELL_PATH, USER_NAME]);
	} else {
		const [, , , , , home, shell] = stdout.trim().split(':');
		if (home !== HOME_PATH || shell !== SHELL_PATH) {
			await execa('usermod', ['--home', HOME_PATH, '--shell', SHELL_PATH, USER_NAME]);
		}
	}

	const { stdout: shadow } = await execa('getent', ['shadow', USER_NAME]);
	if (shadow.trim().split(':')[1] !== '*') {
		await execa('usermod', ['--password', '*', USER_NAME]);
	}

	await ensureDirectory(HOME_PATH, 0o755);
	await ensureDirectory(path.dirname(AUTHORIZED_KEYS_PATH), 0o755);
};

const ensureClientKey = async () => {
	await ensureDirectory(CLIENT_PATH, 0o700);
	const { exitCode, stdout } = await execa('ssh-keygen', ['-y', '-f', PRIVATE_KEY_PATH], { reject: false });
	const derived = stdout.trim().split(/\s+/).slice(0, 2).join(' ');
	if (exitCode === 0 && KEY_PATTERN.test(derived)) {
		if (await readKey(PUBLIC_KEY_PATH) !== derived) {
			await writeIfChanged(PUBLIC_KEY_PATH, `${derived} ${USER_NAME}\n`, 0o644);
		}

		return derived;
	}

	log.info('The replication key is missing or unreadable; creating a new one.');
	await fs.rm(PRIVATE_KEY_PATH, { force: true });
	await fs.rm(PUBLIC_KEY_PATH, { force: true });
	await execa('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', USER_NAME, '-f', PRIVATE_KEY_PATH]);
	await fs.chmod(PRIVATE_KEY_PATH, 0o600);
	return readKey(PUBLIC_KEY_PATH);
};

const ensureHostKey = async () => {
	const existing = await readKey(HOST_KEY_PATH);
	if (existing) {
		return existing;
	}

	log.info('The SSH host key is missing; creating it.');
	await execa('ssh-keygen', ['-A']);
	await execa('systemctl', ['reload-or-restart', 'ssh'], { reject: false });
	return readKey(HOST_KEY_PATH);
};

const ensurePoolPermissions = async () => {
	const { stdout: zpoolList } = await execa('zpool', ['list', '-j']);
	const pools = Object.keys(JSON.parse(zpoolList || '{}')?.pools || {});
	for (const pool of pools) {
		await execa('zfs', ['allow', '-u', USER_NAME, POOL_PERMISSIONS, pool]);
	}
};

const ensureLocal = async () => {
	await ensureUser();
	const publicKey = await ensureClientKey();
	const hostKey = await ensureHostKey();
	await ensurePoolPermissions();
	return (publicKey && hostKey ? { publicKey, hostKey } : null);
};

const readPeers = async () => {
	const { peers, externalPeers } = await DataService.getConfiguration();
	return [...(peers || []), ...(externalPeers || [])];
};

const readIdentities = async () => {
	return (await DataService.getConfiguration()).replicationPeers || [];
};

const storeIdentity = async (peerId, publicKey, hostKey) => {
	const identities = await readIdentities();
	const current = identities.find((entry) => { return entry.id === peerId; });
	if (current?.publicKey === publicKey && current?.hostKey === hostKey) {
		return;
	}

	await DataService.setConfiguration('replicationPeers', [...identities.filter((entry) => { return entry.id !== peerId; }), { id: peerId, publicKey, hostKey }]);
	log.info(`Stored new backup keys for ${peerId}.`);
};

const writeAccess = async () => {
	const peers = await readPeers();
	const identities = await readIdentities();
	const kept = identities.filter((entry) => { return peers.some((peer) => { return peer.id === entry.id; }); });
	if (kept.length !== identities.length) {
		await DataService.setConfiguration('replicationPeers', kept);
	}

	const entries = peers.map((peer) => {
		return { peer, identity: kept.find((entry) => { return entry.id === peer.id; }) };
	}).filter(({ peer, identity }) => {
		return identity && isNodeId(peer.id) && ADDRESS_PATTERN.test(String(peer.address || ''));
	});

	const recipients = entries.filter(({ peer }) => { return peer.role !== 'source'; });
	const sources = entries.filter(({ peer }) => { return peer.role !== 'recipient'; });
	const authorizedKeys = recipients.map(({ peer, identity }) => {
		return `restrict,from="${peer.address}" ${identity.publicKey} ${USER_NAME}@${peer.id}\n`;
	}).join('');
	const knownHosts = sources.map(({ peer, identity }) => {
		return `${peer.id} ${identity.hostKey}\n`;
	}).join('');
	const sshConfig = sources.map(({ peer }) => {
		return [
			`Host ${peer.id}`,
			`\tHostName ${peer.address}`,
			`\tUser ${USER_NAME}`,
			`\tIdentityFile ${PRIVATE_KEY_PATH}`,
			'\tIdentitiesOnly yes',
			`\tHostKeyAlias ${peer.id}`,
			`\tUserKnownHostsFile ${KNOWN_HOSTS_PATH}`,
			'\tGlobalKnownHostsFile none',
			'\tStrictHostKeyChecking yes',
			'\tPasswordAuthentication no',
			'\tKbdInteractiveAuthentication no',
			''
		].join('\n');
	}).join('\n');

	log.info(`Backup access: ${recipients.length} node(s) may take backups from this node, this node takes backups from ${sources.length} node(s).`);
	await writeIfChanged(AUTHORIZED_KEYS_PATH, authorizedKeys, 0o644);
	await writeIfChanged(KNOWN_HOSTS_PATH, knownHosts, 0o600);
	await writeIfChanged(SSH_CONFIG_PATH, sshConfig, 0o600);
};

const readIdentity = (payload) => {
	const publicKey = String(payload?.publicKey || '');
	const hostKey = String(payload?.hostKey || '');
	return (KEY_PATTERN.test(publicKey) && KEY_PATTERN.test(hostKey) ? { publicKey, hostKey } : null);
};

const exchangeWith = async (peer, own) => {
	const identity = readIdentity(await hostModule.getPlugin('peer').call(peer.id, 'replication:exchange', own));
	if (!identity) {
		throw new Error(`${peer.name || peer.address} sent replication keys that are not valid.`);
	}

	await prepareLocally(() => { return storeIdentity(peer.id, identity.publicKey, identity.hostKey); });
	log.info(`Exchanged backup keys with ${peer.name || peer.address} (${peer.id}).`);
};

const sync = async () => {
	if (syncing) {
		syncAgain = true;
		return;
	}

	syncing = true;
	try {
		do {
			syncAgain = false;
			const own = await exclusive(ensureLocal);
			const peers = await readPeers();
			log.info(`Exchanging backup keys with ${peers.length} node(s).`);
			for (const peer of (own ? peers : [])) {
				try {
					await exchangeWith(peer, own);
				} catch (error) {
					log.warn(`Could not exchange replication keys with ${peer.name || peer.address}:`, error);
				}
			}

			await exclusive(writeAccess);
		} while (syncAgain);
	} catch (error) {
		log.warn('Could not prepare replication:', error);
	} finally {
		syncing = false;
	}
};

const exchange = async (peerId, payload) => {
	const identity = readIdentity(payload);
	if (!identity) {
		return null;
	}

	try {
		return await exclusive(async () => {
			const own = await ensureLocal();
			await storeIdentity(peerId, identity.publicKey, identity.hostKey);
			await writeAccess();
			log.info(`Received backup keys from ${peerId} and sent this node's keys back.`);
			return own;
		});
	} catch (error) {
		log.warn('Could not prepare replication:', error);
		return null;
	}
};

const pair = async (peerId) => {
	const own = await prepareLocally(ensureLocal);
	const peer = (await readPeers()).find((entry) => { return entry.id === peerId; });
	if (!own || !peer) {
		throw new Error('This node could not prepare its backups. Try again, or restart it if it keeps failing.');
	}

	await exchangeWith(peer, own);
	await prepareLocally(writeAccess);
};

const verify = async (peerId) => {
	log.info(`Logging in to ${peerId} over SSH to check backups can be taken.`);
	await execa('ssh', ['-F', SSH_CONFIG_PATH, '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${SSH_TIMEOUT_SECONDS}`, peerId, 'true'], { timeout: SSH_TIMEOUT_SECONDS * 2000 });
	log.info(`SSH login to ${peerId} succeeded.`);
};

const register = (module) => {
	hostModule = module;
	sync();
	module.eventEmitter.on('host:peers:updated', () => {
		sync();
	});
	module.eventEmitter.on('host:peers:external:updated', () => {
		sync();
	});
	module.eventEmitter.on('host:storage:prepared', () => {
		sync();
	});
};

export default {
	name: 'replication',
	register,
	exchange,
	pair,
	verify
};
