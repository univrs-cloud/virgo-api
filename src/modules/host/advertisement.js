import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import si from 'systeminformation';
import { execa } from 'execa';
import ini from 'ini';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as setup from '../../utils/setup_state.js';
import { getOwnAddress, holdsAddress } from '../../utils/network.js';


const SERVICE_FILE = '/etc/avahi/services/univrs.service';
const SERVICE_TYPE = '_univrs._tcp';
const CLUSTER_SERVICE_FILE = '/etc/avahi/services/cluster.service';
const HOSTS_FILE = '/etc/avahi/hosts';
const SAMBA_PORT = 445;
const NETBIOS_UNIT = 'nmbd.service';
const VIRTUAL_IP_UNIT = 'virgo-virtual-ip.service';
const SAMBA_CONFIGURATION_FILE = '/etc/samba/smb.conf';
const SETTLE_INTERVAL_MS = 2000;
const SETTLE_TIMEOUT_MS = 180000;
const MACHINE_ID_FILE = '/etc/machine-id';
const ID_NAMESPACE = 'univrs:node-discovery';

let cachedNodeId = null;
let advertiseQueue = Promise.resolve();

/** Stable per appliance and safe to publish. */
const getNodeId = async () => {
	if (cachedNodeId) {
		return cachedNodeId;
	}

	const machineId = (await fs.readFile(MACHINE_ID_FILE, 'utf8')).trim();

	if (!machineId) {
		throw new Error(`${MACHINE_ID_FILE} is empty`);
	}

	cachedNodeId = crypto
		.createHash('sha256')
		.update(`${ID_NAMESPACE}:${machineId}`)
		.digest('hex')
		.slice(0, 16);

	return cachedNodeId;
};

const escapeXml = (value) => {
	return String(value).replace(/[<>&'"]/g, (character) => {
		return {
			'<': '&lt;',
			'>': '&gt;',
			'&': '&amp;',
			"'": '&apos;',
			'"': '&quot;'
		}[character];
	});
};

const sleep = (ms) => {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
};

const readIdentity = async () => {
	const { hostname, fqdn } = await si.osInfo();
	const prefix = `${hostname}.`;
	return {
		hostname,
		domainName: (hostname && String(fqdn || '').startsWith(prefix) ? fqdn.slice(prefix.length).toLowerCase() : '')
	};
};

const buildRecords = async () => {
	const records = {
		id: await getNodeId(),
		name: os.hostname(),
		setup: (setup.isCompleted() ? 'complete' : 'incomplete')
	};

	const { virtualIp } = await DataService.getConfiguration();
	const address = await getOwnAddress(virtualIp?.address);

	if (address) {
		records.address = address;
	}

	if (virtualIp?.address) {
		records.virtualip = virtualIp.address;
		records.holds = (await holdsAddress(virtualIp.address) ? '1' : '0');
	}

	const { domainName } = await readIdentity();
	if (domainName.split('.').length >= 3) {
		records.cluster = domainName;
	}

	return records;
};

const buildDocument = (records) => {
	const txt = Object.entries(records)
		.map(([key, value]) => {
			return `    <txt-record>${escapeXml(`${key}=${value}`)}</txt-record>`;
		})
		.join('\n');

	return `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service>
    <type>${SERVICE_TYPE}</type>
    <port>${config.server.port}</port>
${txt}
  </service>
</service-group>
`;
};

const buildClusterDocument = ({ name, hostName, model, timeMachines }) => {
	const host = `\n    <host-name>${escapeXml(hostName)}</host-name>`;
	const disks = timeMachines.map((share, index) => {
		return `\n    <txt-record>${escapeXml(`dk${index}=adVN=${share},adVF=0x82`)}</txt-record>`;
	}).join('');
	const adisk = (timeMachines.length > 0 ? `
  <service>
    <type>_adisk._tcp</type>
    <port>0</port>${host}${disks}
    <txt-record>sys=adVF=0x100</txt-record>
  </service>` : '');

	return `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>${escapeXml(name)}</name>
  <service>
    <type>_smb._tcp</type>
    <port>${SAMBA_PORT}</port>${host}
  </service>
  <service>
    <type>_device-info._tcp</type>
    <port>0</port>${host}
    <txt-record>${escapeXml(`model=${model}`)}</txt-record>
  </service>${adisk}
</service-group>
`;
};

const readFile = async (file) => {
	try {
		return await fs.readFile(file, 'utf8');
	} catch (error) {
		return null;
	}
};

/** Written atomically so Avahi never sees a partially written service file. */
/** The temporary file is kept out of the directory avahi watches. Avahi reloads on any change there,
 * not only on files it will read, so staging inside it makes one update land as three reloads — and
 * every reload withdraws and re-announces the service. Same filesystem, so the rename is still atomic
 * and arrives as a single event. */
const writeFile = async (file, document) => {
	if (await readFile(file) === document) {
		return;
	}

	const directory = path.dirname(file);
	const temporaryFile = path.join(path.dirname(directory), `.${path.basename(file)}.tmp`);

	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(temporaryFile, document, 'utf8');
	await fs.rename(temporaryFile, file);
};

const removeFile = async (file) => {
	await fs.rm(file, { force: true });
};

const updateSambaName = async (cluster) => {
	const original = await fs.readFile(SAMBA_CONFIGURATION_FILE, 'utf8');
	let configuration = original;
	for (const [key, value] of Object.entries({
		'netbios name': cluster.toLowerCase().slice(0, 15),
		'server string': cluster.toLowerCase(),
		'multicast dns register': 'no'
	})) {
		const option = new RegExp(`^[\\t ]*${key}[\\t ]*=.*$`, 'gmi');
		const setting = `   ${key} = ${value}`;
		configuration = (option.test(configuration)
			? configuration.replace(option, setting)
			: configuration.replace(/^[\t ]*\[global\][\t ]*$/mi, `$&\n${setting}`));
	}
	if (configuration === original) {
		return;
	}

	await fs.writeFile(SAMBA_CONFIGURATION_FILE, configuration, 'utf8');
	const { exitCode: winbindActive } = await execa('systemctl', ['is-active', '--quiet', 'winbind.service'], { reject: false });
	if (winbindActive === 0) {
		await execa('systemctl', ['try-restart', 'winbind.service']);
	}
	await execa('systemctl', ['try-restart', 'smbd.service', NETBIOS_UNIT]);
};

const isVirtualIpActivating = async () => {
	const { stdout } = await execa('systemctl', ['is-active', VIRTUAL_IP_UNIT], { reject: false });
	return stdout.trim().toLowerCase() === 'activating';
};

const setNetbios = async (isAnnouncing) => {
	const { stdout } = await execa('systemctl', ['is-enabled', NETBIOS_UNIT], { reject: false });
	const isEnabled = (stdout.trim().toLowerCase() === 'enabled');
	if (isAnnouncing && !isEnabled) {
		await execa('systemctl', ['enable', '--now', NETBIOS_UNIT]);
	} else if (!isAnnouncing && isEnabled) {
		await execa('systemctl', ['disable', '--now', NETBIOS_UNIT]);
	}
};

const announceCluster = async () => {
	const { virtualIp } = await DataService.getConfiguration();
	const { hostname, domainName } = await readIdentity();
	const labels = domainName.split('.');
	const name = (labels.length >= 3 ? labels[0] : hostname).toLowerCase();
	await updateSambaName(name);

	const isAnnouncing = Boolean(virtualIp?.address && await holdsAddress(virtualIp.address));
	await setNetbios(isAnnouncing);

	if (!isAnnouncing) {
		await removeFile(CLUSTER_SERVICE_FILE);
		await removeFile(HOSTS_FILE);
		return;
	}

	const { stdout } = await execa('testparm', ['-s', '-l']);
	const samba = ini.parse(stdout);
	const timeMachines = Object.keys(samba).filter((share) => { return String(samba[share]['fruit:time machine'] || '').toLowerCase() === 'yes'; });
	const model = (samba.global?.['fruit:model'] || 'MacSamba');

	await writeFile(HOSTS_FILE, `${virtualIp.address} ${name}.local\n`);
	await writeFile(CLUSTER_SERVICE_FILE, buildClusterDocument({ name, hostName: `${name}.local`, model, timeMachines }));
};

/** Serialize advertisements so multiple events cannot race on the temporary file. */
const advertise = () => {
	const previous = advertiseQueue;
	advertiseQueue = (async () => {
		try {
			await previous;
			await writeFile(SERVICE_FILE, buildDocument(await buildRecords()));
		} catch (error) {
			console.warn(`Could not publish the discovery service: ${error.shortMessage || error.message}`);
		}

		try {
			await announceCluster();
		} catch (error) {
			console.warn(`Could not publish the cluster shares: ${error.shortMessage || error.message}`);
		}
	})();

	return advertiseQueue;
};

const advertiseWhenSettled = async () => {
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	let hasWaited = false;
	while (await isVirtualIpActivating() && Date.now() < deadline) {
		hasWaited = true;
		await sleep(SETTLE_INTERVAL_MS);
	}

	if (hasWaited) {
		advertise();
	}
};

const register = (module) => {
	advertise();
	advertiseWhenSettled();

	setup.watchCompleted(() => {
		advertise();
	});

	module.eventEmitter
		.on('host:network:identifier:updated', () => {
			advertise();
		})
		.on('host:network:virtualIp:updated', () => {
			advertise();
		})
		.on('shares:updated', () => {
			advertise();
		});
};

export default {
	name: 'advertisement',
	register
};

export { getNodeId };
