import { execa } from 'execa';
import { getNodeId } from './advertisement.js';

const SERVICE_TYPE = '_univrs._tcp';
const BROWSE_TIMEOUT_MS = 5000;

/** avahi-browse escapes `;` inside a field, so splitting on a bare separator would shift every
 * following index whenever a node's name contains one. */
const splitFields = (line) => {
	return line.split(/(?<!\\);/).map((field) => { return field.replace(/\\;/g, ';'); });
};

/** The whole TXT set arrives as one field of space-separated quoted pairs. */
const parseTxt = (blob) => {
	const records = {};
	for (const [, entry] of String(blob || '').matchAll(/"([^"]*)"/g)) {
		const separator = entry.indexOf('=');
		if (separator > 0) {
			records[entry.slice(0, separator)] = entry.slice(separator + 1);
		}
	}

	return records;
};

/** `-t` stops once the cache is exhausted, which can cut off a slow responder, so the timeout is the
 * real bound and a timed-out browse still yields whatever arrived before it fired. */
const browse = async () => {
	try {
		const { stdout } = await execa('avahi-browse', ['-rpt', SERVICE_TYPE], { timeout: BROWSE_TIMEOUT_MS });
		return stdout;
	} catch (error) {
		if (error.timedOut) {
			return error.stdout || '';
		}

		throw error;
	}
};

/** Resolved IPv4 records only, keyed by node id so a node answering on several interfaces is listed
 * once, and with this node filtered out. */
const discover = async () => {
	const selfId = await getNodeId();
	const peers = new Map();
	for (const line of (await browse()).split('\n')) {
		const fields = splitFields(line);
		if (fields[0] !== '=' || fields[2] !== 'IPv4') {
			continue;
		}

		const records = parseTxt(fields[9]);
		if (!records.id || records.id === selfId || peers.has(records.id)) {
			continue;
		}

		peers.set(records.id, {
			id: records.id,
			name: records.name || fields[3] || '',
			address: fields[7] || '',
			setupCompleted: records.setup === 'complete',
			virtualIp: records.virtualip || null,
			holdsVirtualIp: records.holds === '1',
			version: records.ver || ''
		});
	}

	return [...peers.values()];
};

const onConnection = (socket, module) => {
	socket.on('host:discovery:fetch', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		try {
			socket.emit('host:discovery', await discover());
		} catch (error) {
			socket.emit('host:discovery', false);
		}
	});
};

export default {
	name: 'discovery',
	onConnection
};

export { discover, splitFields, parseTxt };
