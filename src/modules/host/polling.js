import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';
import si from 'systeminformation';
import camelcaseKeys from 'camelcase-keys';
import Poller from '../../utils/poller.js';
import * as certificate from '../../utils/certificate.js';
import * as setup from '../../utils/setup_state.js';
import { getTopologies } from './topology.js';

const BY_ID_DIR = '/dev/disk/by-id';
const ID_PREFIXES = ['nvme-eui.', 'wwn-', 'ata-', 'scsi-', 'virtio-'];
const SYSTEM_MOUNTPOINTS = ['/', '[SWAP]'];
// Memory-backed block devices. lsblk types these as disks, and a zram holding no swap looks like an
// empty drive, so nothing but the name tells them apart from something a pool can be built on.
const VOLATILE_DEVICE = /^(?:zram|ram)\d+$/;
const CERTIFICATE_INTERVAL_MS = 10000;
const KELVIN_OFFSET = 273;
const DEFAULT_TEMPERATURE_THRESHOLD = 99;
const polls = [];
let certificatePoll = null;

const parseJson = (stdout) => {
	try {
		return JSON.parse(stdout || '{}');
	} catch (error) {
		return {};
	}
};

const getNetworkStats = async (module) => {
	try {
		const system = module.getState('system');
		const defaultInterface = system?.networkInterfaces?.find((iface) => { return iface.default; });
		const ifaceName = defaultInterface?.ifname || null;
		const networkStats = await si.networkStats(ifaceName);
		let networkInterfaceStats = networkStats[0];
		if (!networkInterfaceStats) {
			networkInterfaceStats = {
				rx_sec: 0,
				tx_sec: 0
			};
		}
		if (networkInterfaceStats?.rx_sec === null) {
			networkInterfaceStats.rx_sec = 0;
		}
		if (networkInterfaceStats.tx_sec === null) {
			networkInterfaceStats.tx_sec = 0;
		}
		module.setState('networkStats', networkInterfaceStats);
	} catch (error) {
		console.error('getNetworkStats:', error);
		module.setState('networkStats', false);
	}
	module.nsp.emit('host:network:stats', module.getState('networkStats'));
};

const getCpuStats = async (module) => {
	try {
		const currentLoad = await si.currentLoad();
		const cpuTemperature = await si.cpuTemperature();
		const { stdout: fan } = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true });
		module.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan ? fan.trim() : '') });
	} catch (error) {
		console.error('getCpuStats:', error);
		module.setState('cpuStats', false);
	}
	module.nsp.emit('host:cpu:stats', module.getState('cpuStats'));
};

const getMemory = async (module) => {
	try {
		const memory = await si.mem();
		module.setState('memory', memory);
	} catch (error) {
		console.error('getMemory:', error);
		module.setState('memory', false);
	}
	module.nsp.emit('host:memory', module.getState('memory'));
};

/** Maps each drive's controller device to every `/dev/disk/by-id` alias pointing at it. Device names
 * are assigned in probe order and can move between boots, so these are the identifiers anything
 * pointing at a specific drive — zpool above all — has to use, and a pool records whichever alias it
 * was created with (`wwn-*` and `ata-*` for SATA, `nvme-eui.*` for NVMe). */
const getDriveIds = async () => {
	const ids = {};
	try {
		for (const entry of await fs.readdir(BY_ID_DIR)) {
			if (entry.includes('-part')) {
				continue;
			}

			const device = await fs.realpath(path.join(BY_ID_DIR, entry));
			ids[device] = [...(ids[device] || []), entry];
		}
	} catch (error) {
		console.error('getDriveIds:', error);
	}

	return ids;
};

/** A pool member has to be named by something that survives a reboot. Device names are assigned in
 * probe order, so a `/dev/disk/by-id` alias is used wherever the drive has one; a virtual disk with
 * no serial has none, and its device path is all there is to name it by. */
const getPreferredId = (aliases, devicePath) => {
	for (const prefix of ID_PREFIXES) {
		const alias = aliases.find((entry) => { return entry.startsWith(prefix); });
		if (alias) {
			return alias;
		}
	}

	return aliases[0] || devicePath;
};

const isSystemMountpoint = (mountpoint) => {
	return Boolean(mountpoint) && (SYSTEM_MOUNTPOINTS.includes(mountpoint) || mountpoint.startsWith('/boot'));
};

/** Whether the system lives on this disk, asked of the whole tree: the root and boot filesystems sit
 * on partitions, so the disk carrying them only shows it through its children. */
const isSystemDevice = (device) => {
	if ((device.mountpoints || [device.mountpoint]).some(isSystemMountpoint)) {
		return true;
	}

	return (device.children || []).some(isSystemDevice);
};

const listBlockDevices = async () => {
	try {
		const { stdout } = await execa('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,RM,RO,MODEL,SERIAL,MOUNTPOINTS']);
		return JSON.parse(stdout || '{}').blockdevices || [];
	} catch (error) {
		console.error('listBlockDevices:', error);
		return [];
	}
};

const getDrives = async (module) => {
	try {
		const driveIds = await getDriveIds();
		const devices = (await listBlockDevices()).filter((device) => {
			return device.type === 'disk' && !device.rm && !device.ro && !VOLATILE_DEVICE.test(device.name) && !isSystemDevice(device);
		});
		const drives = await Promise.all(devices.map(async (device) => {
			const isNvme = device.name.startsWith('nvme');
			const [{ stdout: smartctl }, { stdout: nvme }] = await Promise.all([
				execa('smartctl', ['-a', '-j', device.path], { reject: false }),
				(isNvme ? execa('nvme', ['id-ctrl', '-o', 'json', device.path], { reject: false }) : { stdout: '' })
			]);
			const drive = parseJson(smartctl);
			const limits = parseJson(nvme);
			const aliases = (driveIds[device.path] || []);
			const size = Number(device.size) || drive?.user_capacity?.bytes || null;
			return {
				name: device.name,
				path: device.path,
				id: getPreferredId(aliases, device.path),
				ids: aliases,
				model: (drive?.model_name || device.model || null),
				serialNumber: (drive?.serial_number || device.serial || null),
				size,
				capacity: (drive?.user_capacity || { bytes: size }),
				temperature: drive?.temperature?.current,
				temperatureWarningThreshold: (Number.isFinite(limits?.wctemp) ? limits.wctemp - KELVIN_OFFSET : DEFAULT_TEMPERATURE_THRESHOLD),
				temperatureCriticalThreshold: (Number.isFinite(limits?.cctemp) ? limits.cctemp - KELVIN_OFFSET : DEFAULT_TEMPERATURE_THRESHOLD)
			};
		}));
		module.setState('drives', drives);
	} catch (error) {
		console.error('getDrives:', error);
		module.setState('drives', false);
	}
	module.setState('topologies', getTopologies(module.getState('drives') || []));
	module.emitChanged('host:drives', module.getState('drives'));
	module.emitChanged('host:storage:topologies', module.getState('topologies'));
};

;

const getStorage = async (module) => {
	try {
		const [{ stdout: zpoolList }, { stdout: zpoolStatus }, { stdout: zfsList }] = await Promise.all([
			execa('zpool', ['list', '-j', '--json-int']).catch(() => ({ stdout: '{"pools":{}}' })),
			execa('zpool', ['status', '-j', '--json-int']).catch(() => ({ stdout: '{"pools":{}}' })),
			execa('zfs', ['list', '-o', 'usedbydataset,usedbysnapshots,used,logicalused', '-r', '-j', '--json-int']).catch(() => ({ stdout: '{"datasets":{}}' }))
		]);
		const pools = JSON.parse(zpoolList || '{}')?.pools || {};
		const statuses = JSON.parse(zpoolStatus || '{}')?.pools || {};
		const datasets = JSON.parse(zfsList || '{}')?.datasets || {};
		let storage = [];
		for (const pool of Object.values(pools)) {
			const poolDatasets = Object.values(datasets).filter((dataset) => {
				return dataset?.name === pool?.name || dataset?.name?.startsWith(`${pool?.name}/`);
			});
			const datasetsSize = poolDatasets.reduce((sum, dataset) => {
				return sum + (dataset?.properties?.usedbydataset?.value || 0);
			}, 0);
			const snapshotsSize = poolDatasets.reduce((sum, dataset) => {
				return sum + (dataset?.properties?.usedbysnapshots?.value || 0);
			}, 0);
			const rootDataset = poolDatasets.find((dataset) => { return dataset?.name === pool?.name; });
			const used = (rootDataset?.properties?.used?.value || 0);
			const logicalUsed = (rootDataset?.properties?.logicalused?.value || 0);
			pool.properties.usedbydatasets = { value: datasetsSize };
			pool.properties.usedbysnapshots = { value: snapshotsSize };
			pool.properties.logicalused = { value: logicalUsed };
			pool.properties.compressratio = { value: (used > 0 ? logicalUsed / used : 1) };
			pool.properties.savedbycompression = { value: Math.max(logicalUsed - used, 0) };
			storage.push({ ...pool, ...statuses[pool.name] });
		}
		const filesystems = await si.fsSize();
		const filesystem = filesystems.find((filesystem) => { return filesystem.mount === '/'; });
		if (filesystem) {
			const pool = {
				name: 'system',
				properties: {
					health: {
						value: 'ONLINE'
					},
					size: {
						value: filesystem?.size
					},
					allocated: {
						value: filesystem?.used
					},
					free: {
						value: filesystem?.available
					},
					capacity: {
						value: filesystem?.use
					}
				}
			}
			storage.push(pool);
		}
		storage = camelcaseKeys(storage, { deep: true });
		module.setState('storage', storage);
	} catch (error) {
		console.error('getStorage:', error);
		module.setState('storage', false);
	}
	module.emitChanged('host:storage', module.getState('storage'));
	module.eventEmitter.emit('host:storage:updated', module.getState('storage'));
};

const getSnapshots = async (module) => {
	try {
		const { stdout: zfsList } = await execa('zfs', ['list', '-t', 'snapshot', '-r', '-j', '--json-int']);
		const datasets = JSON.parse(zfsList || '{}')?.datasets || {};
		const snapshots = camelcaseKeys(datasets, { deep: true });
		module.setState('snapshots', snapshots);
	} catch (error) {
		console.error('getSnapshots:', error);
		module.setState('snapshots', false);
	}
	module.emitChanged('host:storage:snapshots', module.getState('snapshots'), {
		filter: (socket) => { return socket.isAuthenticated && socket.isAdmin; }
	});
};

const getTime = (module) => {
	try {
		const time = si.time();
		module.setState('time', time);
	} catch (error) {
		console.error('getTime:', error);
		module.setState('time', false);
	}
	module.nsp.emit('host:time', module.getState('time'));
};

const getCertificate = async (module) => {
	const state = await certificate.read();
	module.setState('certificate', state);
	module.emitChanged('host:certificate', state);
	if (state.hasCertificate || setup.isCompleted()) {
		certificatePoll?.stop();
	}
};

const register = (module) => {
	module.eventEmitter.on('host:storage:fetch', () => {
		getStorage(module);
	});
	module.eventEmitter.on('app:installed', ({ name } = {}) => {
		if (name !== 'traefik' || setup.isCompleted()) {
			return;
		}

		certificatePoll = certificatePoll || new Poller(module, getCertificate, CERTIFICATE_INTERVAL_MS);
		certificatePoll.start();
	});

	polls.push(new Poller(module, getNetworkStats, 2000));
	polls.push(new Poller(module, getCpuStats, 5000));
	polls.push(new Poller(module, getMemory, 10000));
	polls.push(new Poller(module, getDrives, 60000));
	polls.push(new Poller(module, getStorage, 60000));
	polls.push(new Poller(module, getSnapshots, 60 * 60 * 1000));
	polls.push(new Poller(module, getTime, 60000));
};

const startPolling = () => {
	polls.forEach((poll) => {
		poll.start();
	});
};

export default {
	name: 'polling',
	register,
	startPolling
};
