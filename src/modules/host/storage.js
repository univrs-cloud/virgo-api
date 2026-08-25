import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';
import config from '../../../config.js';
import { open as openDatabase } from '../../database/index.js';
import DataService from '../../database/data_service.js';

// The node's pool. Nothing else may be created or imported under this node's name.
const POOL_NAME = 'messier';
const POOL_OPTIONS = ['-o', 'ashift=13', '-o', 'autotrim=on', '-O', 'compression=lz4', '-O', 'atime=off'];
// Vdev layouts a pool may be asked for, and the drives each one needs. The name doubles as the zpool
// keyword. Only redundant layouts: this pool holds the node's data, so a stripe is never offered.
const REDUNDANCY = {
	mirror: 2,
	raidz1: 3,
	raidz2: 4,
	raidz3: 5
};
// Parents before children: a dataset cannot be created under one that does not exist yet.
const DATASETS = [
	{ name: `${POOL_NAME}/docker`, options: ['-o', 'mountpoint=/var/lib/docker'] },
	{ name: `${POOL_NAME}/containerd`, options: ['-o', 'mountpoint=/var/lib/containerd'] },
	{ name: `${POOL_NAME}/docker/compose`, options: ['-o', 'mountpoint=/opt/docker'] },
	{ name: `${POOL_NAME}/apps`, options: [] },
	{ name: `${POOL_NAME}/folders`, options: [] },
	{ name: `${POOL_NAME}/time_machines`, options: ['-o', 'mountpoint=/time_machines'] },
	{ name: `${POOL_NAME}/downloads`, options: [] }
];
// Stop order; starting walks it backwards so containerd is up before docker wants it.
const DOCKER_UNITS = ['docker.socket', 'docker.service', 'containerd.service'];
// Datasets mount over these, so whatever lives there first has to be moved aside and put back.
const DOCKER_DATA = [
	{ path: '/var/lib/docker', backup: '/var/lib/docker.orig', dataset: `${POOL_NAME}/docker` },
	{ path: '/var/lib/containerd', backup: '/var/lib/containerd.orig', dataset: `${POOL_NAME}/containerd` }
];
const DOCKER_NETWORK = ['--driver=bridge', '--subnet=172.30.0.0/16', '--ip-range=172.30.10.0/24', '--gateway=172.30.0.1', 'virgo'];
const BY_ID_DIR = '/dev/disk/by-id';
const SHARES_DIR = `/${POOL_NAME}/.shares`;
const CONFIG_DIR = `/${POOL_NAME}/.config`;
const SHARE_FILES = ['downloads.conf', 'folders.conf', 'time_machines.conf'];
const OWNER = 'voyager:users';
// Nothing can be signed into until these exist: traefik answers on the node's name, authelia owns the
// accounts and the file the password step writes to. DOMAIN is the node's own name, which each
// template prefixes itself, routing to traefik.<fqdn> and auth.<fqdn>. Certificates come from Let's
// Encrypt, with expiry notices going to us rather than the customer — they never asked for one, and
// it is obtained on their node's behalf.
const SSL_EMAIL = 'voyager@univrs.cloud';
const isFleetZone = (fqdn) => { return String(fqdn || '').toLowerCase().endsWith(`.${config.fleet.zone}`); };
const CORE_APPS = [
	{ name: 'authelia', env: (fqdn) => { return { DOMAIN: fqdn, CERTRESOLVER: (isFleetZone(fqdn) ? '' : 'le') }; } },
	{ name: 'traefik', env: (fqdn) => { return { DOMAIN: fqdn, CERTRESOLVER: (isFleetZone(fqdn) ? 'ledns' : 'le'), EMAIL: SSL_EMAIL }; } }
];

let scanning = null;

/** `zpool import` is the only way to see pools that aren't imported yet and it has no JSON output,
 * so its report is parsed by indentation:
 *
 *    pool: messier
 *      id: 1234567890
 *   state: ONLINE
 *  action: The pool can be imported using its name or numeric identifier.
 *  config:
 *
 *         messier          ONLINE      <- depth 0, the pool itself
 *           mirror-0       ONLINE      <- depth 1, a vdev
 *             nvme-eui.01  ONLINE      <- depth 2, a member drive
 */
const parseConfig = (lines, poolName) => {
	const vdevs = [];
	let baseIndent = null;
	for (const line of lines) {
		const [name, state] = line.trim().split(/\s+/);
		if (!name || name === poolName) {
			continue;
		}

		const indent = line.search(/\S/);
		if (baseIndent === null) {
			baseIndent = indent;
		}

		// Anything deeper than the first entry belongs to the vdev above it; a pool of bare drives has
		// no deeper level, so those drives become their own single-device entries.
		if (indent > baseIndent && vdevs.length > 0) {
			vdevs[vdevs.length - 1].devices.push({ name, state });
			continue;
		}

		vdevs.push({ name, state, devices: [] });
	}

	return vdevs;
};

const parseImportablePools = (output) => {
	const blocks = output.split(/^(?=\s*pool:\s)/m).filter((block) => { return /\s*pool:\s/.test(block); });
	return blocks.map((block) => {
		const lines = block.split('\n');
		const field = (name) => {
			return lines.find((line) => { return line.trim().startsWith(`${name}:`); })?.split(':').slice(1).join(':').trim() || null;
		};
		const configIndex = lines.findIndex((line) => { return line.trim().startsWith('config:'); });
		const name = field('pool');
		return {
			name,
			id: field('id'),
			state: field('state'),
			status: field('status'),
			action: field('action'),
			vdevs: (configIndex === -1 ? [] : parseConfig(lines.slice(configIndex + 1), name))
		};
	}).filter((pool) => { return Boolean(pool.name); });
};

/** Pools on the drives that aren't imported: what the setup wizard offers to adopt instead of
 * creating a new one. `false` means the scan itself failed, which is not the same as finding none. */
const scanImportablePools = async (module) => {
	if (scanning) {
		await scanning;
		return;
	}

	scanning = (async () => {
		try {
			// Having nothing to offer is a success: zpool exits 0 and reports it in prose, which parses
			// to an empty list. A throw here is a real failure — no zpool, not root, unreadable devices.
			const { stdout: zpoolImport } = await execa('zpool', ['import']);
			module.setState('importable', parseImportablePools(zpoolImport));
		} catch (error) {
			console.error('scanImportablePools:', error);
			module.setState('importable', false);
		}

		module.nsp.emit('host:storage:importable', module.getState('importable'));
		scanning = null;
	})();

	await scanning;
};

const exists = async (path) => {
	try {
		await fs.access(path);
		return true;
	} catch (error) {
		return false;
	}
};

const hasContent = async (path) => {
	try {
		return (await fs.readdir(path)).length > 0;
	} catch (error) {
		return false;
	}
};

const listPools = async () => {
	const { stdout: zpoolList } = await execa('zpool', ['list', '-j']);
	return Object.keys(JSON.parse(zpoolList || '{}')?.pools || {});
};

const listDatasets = async () => {
	const { stdout: zfsList } = await execa('zfs', ['list', '-j', '-o', 'name']);
	return Object.keys(JSON.parse(zfsList || '{}')?.datasets || {});
};

const isDatasetMounted = async (name) => {
	const { stdout: zfsMounted } = await execa('zfs', ['get', '-j', 'mounted', name], { reject: false });
	return JSON.parse(zfsMounted || '{}')?.datasets?.[name]?.properties?.mounted?.value === 'yes';
};

// One transaction per direction: systemd orders the units by their dependencies, where separate
// invocations would race — a socket still up while its service stops just activates it again.
const stopDocker = async () => {
	await execa('systemctl', ['disable', '--now', ...DOCKER_UNITS], { reject: false });
};

const startDocker = async () => {
	await execa('systemctl', ['enable', '--now', ...[...DOCKER_UNITS].reverse()]);
};

/** Moves whatever docker already has on the system disk out of the way, so the datasets can mount
 * over those directories without burying it. */
const backupDockerData = async () => {
	for (const { path, backup } of DOCKER_DATA) {
		if (await exists(backup) || !await hasContent(path)) {
			continue;
		}

		await execa('cp', ['-a', path, backup]);
		await execa('sh', ['-c', `rm -rf ${path}/*`]);
	}
};

/** Decides what the mounted datasets should hold: the backup is copied in only when the pool's own
 * dataset is empty, since a pool that already carries docker data is the reinstall case and wins.
 * Either way the backup is dropped, so a later run never sees a stale one. */
const reconcileDockerData = async () => {
	for (const { path, backup, dataset } of DOCKER_DATA) {
		if (!await exists(backup)) {
			continue;
		}

		if (!await isDatasetMounted(dataset)) {
			await execa('zfs', ['mount', dataset], { reject: false });
			if (!await isDatasetMounted(dataset)) {
				throw new Error(`Cannot restore ${path}: dataset ${dataset} failed to mount.`);
			}
		}

		if (!await hasContent(path)) {
			await execa('sh', ['-c', `cp -a ${backup}/* ${path}/ 2>/dev/null || true`]);
		}

		await execa('rm', ['-rf', backup]);
	}
};

const createDatasets = async () => {
	const existing = await listDatasets();
	for (const dataset of DATASETS) {
		if (existing.includes(dataset.name)) {
			continue;
		}

		await execa('zfs', ['create', ...dataset.options, dataset.name]);
	}
};

const createDockerNetwork = async () => {
	// Inspecting a network that is not there exits non-zero, which is the answer, not a failure.
	const { stdout: dockerNetwork } = await execa('docker', ['network', 'inspect', 'virgo', '--format', 'json'], { reject: false });
	const network = JSON.parse(dockerNetwork || '[]');
	if (Array.isArray(network) && network.length > 0) {
		return;
	}

	await execa('docker', ['network', 'create', ...DOCKER_NETWORK]);
};

const createDirectories = async () => {
	for (const directory of [SHARES_DIR, CONFIG_DIR, `${CONFIG_DIR}/assets/img/apps`, `${CONFIG_DIR}/assets/img/bookmarks`]) {
		await fs.mkdir(directory, { recursive: true });
	}

	const allConf = `${SHARES_DIR}/all.conf`;
	if (!await exists(allConf)) {
		await fs.writeFile(allConf, `${SHARE_FILES.map((name) => { return `include = ${SHARES_DIR}/${name}`; }).join('\n')}\n`, 'utf8');
	}

	for (const name of SHARE_FILES) {
		const file = `${SHARES_DIR}/${name}`;
		if (!await exists(file)) {
			await fs.writeFile(file, '', 'utf8');
		}
	}

	await execa('chown', [OWNER, '/downloads'], { reject: false });
	for (const directory of [`/${POOL_NAME}/apps`, SHARES_DIR, CONFIG_DIR]) {
		await execa('chown', ['-R', OWNER, directory], { reject: false });
	}
};

/** Queues the apps the node cannot be used without, through the same command an operator would run.
 * The command returns once the work is queued; the installs themselves report their own progress.
 * Forced, because an imported pool already lists them: they are reconfigured for this node's name. */
const installCoreApps = async (job, module) => {
	const fqdn = module.getState('system')?.osInfo?.fqdn;
	if (!fqdn) {
		console.warn('Could not install core apps: this node has no name yet.');
		return;
	}

	for (const app of CORE_APPS) {
		await module.updateJobProgress(job, `Installing ${app.name}...`);
		const { exitCode, stderr } = await execa('virgo', ['apps', 'install', app.name, '--force', '--env-json', JSON.stringify(app.env(fqdn))], { reject: false });
		if (exitCode !== 0) {
			console.error(`Could not install ${app.name}: ${stderr}`);
		}
	}
};

/** Everything the pool needs before anything can be installed on it. Each part checks its own work
 * first, so a job that failed halfway can be run again. */
const prepare = async (job, module) => {
	await module.updateJobProgress(job, 'Creating datasets...');
	await createDatasets();
	await module.updateJobProgress(job, 'Preparing Docker data...');
	await reconcileDockerData();
	await module.updateJobProgress(job, 'Starting Docker...');
	await startDocker();
	await module.updateJobProgress(job, 'Creating Docker network...');
	await createDockerNetwork();
	await module.updateJobProgress(job, 'Creating directories...');
	await createDirectories();
	// The service booted without a pool to keep its database on, so it takes the one just prepared.
	await module.updateJobProgress(job, 'Opening the database...');
	await openDatabase();
	await DataService.initialize();
	// Everything these modules read lives on the pool and was unreachable when they started, so they
	// are told to look again: an imported pool arrives with apps, bookmarks, shares and an enrolment
	// already in it, and samba was configured before its share files existed.
	module.eventEmitter.emit('host:storage:fetch');
	module.eventEmitter.emit('configuration:updated');
	module.eventEmitter.emit('configuration:location:updated');
	module.eventEmitter.emit('configured:updated');
	module.eventEmitter.emit('users:updated');
	await execa('smbcontrol', ['all', 'reload-config'], { reject: false });
	module.eventEmitter.emit('shares:updated');
	await scanImportablePools(module);
};

/** Drives are named by the `nvme-eui.*` entry the drive list reports; a pool is built from the by-id
 * paths so it survives the device names moving between boots. Each one is checked to still be there:
 * the list a client acted on may be minutes old. */
const resolveDrives = async (euis) => {
	const paths = [];
	for (const eui of euis) {
		if (!eui?.startsWith('nvme-eui.') || eui.includes('/')) {
			throw new Error(`${eui} is not a drive identifier.`);
		}

		const path = `${BY_ID_DIR}/${eui}`;
		if (!await exists(path)) {
			throw new Error(`Drive ${eui} is no longer attached.`);
		}

		paths.push(path);
	}

	return paths;
};

const importPool = async (job, module) => {
	const { config } = job.data;
	if (config?.name !== POOL_NAME) {
		throw new Error(`Only the ${POOL_NAME} pool can be imported.`);
	}

	if ((await listPools()).includes(POOL_NAME)) {
		throw new Error(`Pool ${POOL_NAME} is already imported.`);
	}

	// The import auto-mounts its datasets over the live docker directories, so docker has to be down
	// and its data set aside before it happens.
	await module.updateJobProgress(job, 'Stopping Docker...');
	await stopDocker();
	await backupDockerData();
	await module.updateJobProgress(job, `Importing pool ${POOL_NAME}...`);
	await execa('zpool', ['import', '-f', POOL_NAME]);
	await prepare(job, module);
	return `Pool ${POOL_NAME} imported.`;
};

const createPool = async (job, module) => {
	const { config } = job.data;
	if (config?.name !== POOL_NAME) {
		throw new Error(`Only the ${POOL_NAME} pool can be created.`);
	}

	if ((await listPools()).includes(POOL_NAME)) {
		throw new Error(`Pool ${POOL_NAME} already exists.`);
	}

	const minimumDrives = REDUNDANCY[config?.type];
	if (!minimumDrives) {
		throw new Error(`${config?.type || 'No'} redundancy is not supported.`);
	}

	const drives = await resolveDrives(config?.drives || []);
	if (drives.length < minimumDrives) {
		throw new Error(`A ${config.type} pool needs at least ${minimumDrives} drives, ${drives.length} given.`);
	}

	await module.updateJobProgress(job, 'Stopping Docker...');
	await stopDocker();
	await backupDockerData();
	await module.updateJobProgress(job, `Creating pool ${POOL_NAME}...`);
	// -f because the wizard offers this as the deliberate "start over" path: whatever labels these
	// drives carry, including an older pool the user chose not to import, are being replaced.
	await execa('zpool', ['create', '-f', POOL_NAME, config.type, ...drives, ...POOL_OPTIONS]);
	await prepare(job, module);
	return `Pool ${POOL_NAME} created.`;
};

const register = (module) => {
	scanImportablePools(module)
		.catch((error) => { console.error('scanImportablePools:', error); });
};

const onConnection = (socket, module) => {
	socket.on('host:storage:importable:fetch', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		// Drives can settle after boot and disks get plugged in mid-wizard, so the answer is re-taken
		// on request rather than trusting the one from startup.
		scanImportablePools(module);
	});

	socket.on('host:apps:core:install', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:apps:core:install', { username: socket.username });
	});

	socket.on('host:storage:pool:import', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:storage:pool:import', { config, username: socket.username });
	});

	socket.on('host:storage:pool:create', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:storage:pool:create', { config, username: socket.username });
	});
};

export default {
	name: 'storage',
	register,
	onConnection,
	jobs: {
		'host:storage:pool:import': importPool,
		'host:storage:pool:create': createPool,
		'host:apps:core:install': installCoreApps
	}
};
