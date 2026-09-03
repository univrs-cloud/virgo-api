import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import pkg from '../../../package.json' with { type: 'json' };
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as setup from '../../utils/setup_state.js';
import { getOwnAddress, holdsAddress } from '../../utils/network.js';

const { version } = pkg;

const SERVICE_FILE = '/etc/avahi/services/univrs.service';
const SERVICE_TYPE = '_univrs._tcp';
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

const buildRecords = async () => {
	const records = {
		id: await getNodeId(),
		name: os.hostname(),
		setup: (setup.isCompleted() ? 'complete' : 'incomplete'),
		ver: version
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

const readServiceFile = async () => {
	try {
		return await fs.readFile(SERVICE_FILE, 'utf8');
	} catch (error) {
		return null;
	}
};

/** Written atomically so Avahi never sees a partially written service file. */
/** The temporary file is kept out of the directory avahi watches. Avahi reloads on any change there,
 * not only on files it will read, so staging inside it makes one update land as three reloads — and
 * every reload withdraws and re-announces the service. Same filesystem, so the rename is still atomic
 * and arrives as a single event. */
const writeServiceFile = async (document) => {
	const serviceDirectory = path.dirname(SERVICE_FILE);
	const temporaryFile = path.join(path.dirname(serviceDirectory), `.${path.basename(SERVICE_FILE)}.tmp`);

	await fs.mkdir(serviceDirectory, { recursive: true });
	await fs.writeFile(temporaryFile, document, 'utf8');
	await fs.rename(temporaryFile, SERVICE_FILE);
};

/** Serialize advertisements so multiple events cannot race on the temporary file. */
const advertise = () => {
	advertiseQueue = advertiseQueue
		.then(async () => {
			const document = buildDocument(await buildRecords());

			if (await readServiceFile() === document) {
				return;
			}

			await writeServiceFile(document);
		})
		.catch((error) => {
			console.warn(`Could not publish the discovery service: ${error.shortMessage || error.message}`);
		});

	return advertiseQueue;
};

const register = (module) => {
	advertise();

	setup.watchCompleted(() => {
		advertise();
	});

	module.eventEmitter
		.on('host:network:identifier:updated', () => {
			advertise();
		})
		.on('host:network:virtualIp:updated', () => {
			advertise();
		});
};

export default {
	name: 'advertisement',
	register
};

export { getNodeId };
