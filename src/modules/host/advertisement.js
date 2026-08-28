import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execa } from 'execa';
import pkg from '../../../package.json' with { type: 'json' };
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as setup from '../../utils/setup_state.js';

const { version } = pkg;
const SERVICE_FILE = '/etc/avahi/services/univrs.service';
const SERVICE_TYPE = '_univrs._tcp';
const MACHINE_ID_FILE = '/etc/machine-id';
const ID_NAMESPACE = 'univrs:node-discovery';

let cachedNodeId = null;

/** Stable per appliance and safe to publish. The machine id is regenerated per install — export-image
 * clears it — but systemd is explicit that it must not be exposed as-is, so what goes on the wire is
 * an application-specific hash of it. The fleet's nodeId is deliberately not reused: unregistering
 * clears it, and an identity that changes when a node leaves the fleet is no identity at all. */
const getNodeId = async () => {
	if (cachedNodeId) {
		return cachedNodeId;
	}

	const machineId = (await fs.readFile(MACHINE_ID_FILE, 'utf8')).trim();
	if (!machineId) {
		throw new Error(`${MACHINE_ID_FILE} is empty`);
	}

	cachedNodeId = crypto.createHash('sha256').update(`${ID_NAMESPACE}:${machineId}`).digest('hex').slice(0, 16);
	return cachedNodeId;
};

const escapeXml = (value) => {
	return String(value).replace(/[<>&'"]/g, (character) => {
		return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character];
	});
};

const holdsAddress = async (address) => {
	try {
		const { stdout } = await execa('ip', ['-j', 'addr', 'show']);
		return JSON.parse(stdout || '[]').some((iface) => {
			return iface.addr_info?.some((info) => { return info.local === address; });
		});
	} catch (error) {
		return false;
	}
};

const buildRecords = async () => {
	const records = {
		id: await getNodeId(),
		name: os.hostname(),
		setup: (setup.isCompleted() ? 'complete' : 'incomplete'),
		ver: version
	};
	const { virtualIp } = await DataService.getConfiguration();
	if (virtualIp?.address) {
		records.virtualip = virtualIp.address;
		records.holds = (await holdsAddress(virtualIp.address) ? '1' : '0');
	}

	return records;
};

const buildDocument = (records) => {
	const txt = Object.entries(records).map(([key, value]) => {
		return `    <txt-record>${escapeXml(`${key}=${value}`)}</txt-record>`;
	}).join('\n');
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

const readServiceFile = async () => {
	try {
		return await fs.readFile(SERVICE_FILE, 'utf8');
	} catch (error) {
		return null;
	}
};

/** Written atomically: avahi watches the directory and republishes on any change, so a half-written
 * file would be a published half-advertisement. The temporary name deliberately does not end in
 * `.service`, which is the only pattern avahi reads. */
const writeServiceFile = async (document) => {
	const temporaryFile = `${SERVICE_FILE}.tmp`;
	await fs.mkdir(path.dirname(SERVICE_FILE), { recursive: true });
	await fs.writeFile(temporaryFile, document, 'utf8');
	await fs.rename(temporaryFile, SERVICE_FILE);
};

/** Called on every startup rather than only on change: a node set up long before this feature existed
 * has no change to react to, and would otherwise stay unadvertised forever. The content comparison is
 * what keeps that safe — rewriting the file makes avahi withdraw and re-announce the service, so an
 * unconditional write would re-register on the network every five seconds under a restart loop. */
const advertise = async () => {
	try {
		const document = buildDocument(await buildRecords());
		if (await readServiceFile() === document) {
			return;
		}

		await writeServiceFile(document);
	} catch (error) {
		console.warn(`Could not publish the discovery service: ${error.shortMessage || error.message}`);
	}
};

const register = (module) => {
	advertise();
	setup.watchCompleted(() => { advertise(); });
	module.eventEmitter
		.on('host:network:identifier:updated', () => { advertise(); })
		.on('host:network:virtualIp:updated', () => { advertise(); });
};

export default {
	name: 'advertisement',
	register
};

export { getNodeId };
