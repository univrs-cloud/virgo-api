import readline from 'readline';
import { execa } from 'execa';
import { getNodeId } from './advertisement.js';

const SERVICE_TYPE = '_univrs._tcp';
const MIN_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 60000;
const HEALTHY_AFTER_MS = 30000;

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

/** A resolved record. `+` announces a service before it is resolved and carries no TXT, so it is the
 * `=` lines that actually populate the map; `-` carries no TXT either, which is why the interface,
 * protocol and service name are kept as a second key to find the entry to drop. */
const toPeer = (fields) => {
	const records = parseTxt(fields[9]);
	if (!records.id) {
		return null;
	}

	return {
		id: records.id,
		name: records.name || fields[3] || '',
		address: fields[7] || '',
		setupCompleted: records.setup === 'complete',
		virtualIp: records.virtualip || null,
		holdsVirtualIp: records.holds === '1',
		version: records.ver || ''
	};
};

const isSamePeer = (first, second) => {
	if (!first || !second) {
		return false;
	}

	return ['id', 'name', 'address', 'setupCompleted', 'virtualIp', 'holdsVirtualIp', 'version']
		.every((key) => { return first[key] === second[key]; });
};

const serviceKey = (fields) => {
	return `${fields[1]}|${fields[2]}|${fields[3]}`;
};

const peers = new Map();
const keyToId = new Map();
let watcher = null;
let restartDelay = MIN_RESTART_DELAY_MS;
let onChange = null;

const publish = () => {
	onChange?.();
};

/** Only IPv4 and only this node's peers. Returns whether anything actually changed, so a stream of
 * refreshes for an unchanged service does not turn into a stream of socket emissions. */
const applyLine = (line, selfId) => {
	const fields = splitFields(line);
	const [event] = fields;
	if (event !== '=' && event !== '-') {
		return false;
	}

	if (fields[2] !== 'IPv4') {
		return false;
	}

	const key = serviceKey(fields);
	if (event === '-') {
		const id = keyToId.get(key);
		keyToId.delete(key);
		return (id ? peers.delete(id) : false);
	}

	const peer = toPeer(fields);
	if (!peer || peer.id === selfId) {
		return false;
	}

	keyToId.set(key, peer.id);
	const previous = peers.get(peer.id);
	peers.set(peer.id, peer);
	return !isSamePeer(previous, peer);
};

/** Long-lived rather than polled: avahi already knows the moment a node appears or goes away, so
 * asking it repeatedly would be both slower and noisier than letting it tell us. Without `-t` the
 * browse never terminates, so the process is supervised and restarted with a backoff — avahi being
 * restarted underneath must not silently end discovery for the life of the daemon. */
const watch = async () => {
	let selfId = null;
	try {
		selfId = await getNodeId();
	} catch (error) {
		// Without a stable identity this node cannot tell its own advertisement from a peer's, and
		// mistaking itself for a peer would lock the virtual IP field against its own address.
		console.warn(`Discovery is unavailable: ${error.shortMessage || error.message}`);
		return;
	}

	watcher = execa('avahi-browse', ['-rp', SERVICE_TYPE], { buffer: false });
	const stream = readline.createInterface({ input: watcher.stdout });
	stream.on('line', (line) => {
		try {
			if (applyLine(line, selfId)) {
				publish();
			}
		} catch (error) {
			console.warn(`Could not read a discovery record: ${error.message}`);
		}
	});
	watcher.catch(() => {});
	watcher.on('exit', () => {
		stream.close();
		watcher = null;
		peers.clear();
		keyToId.clear();
		publish();
		setTimeout(() => {
			restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
			watch();
		}, restartDelay);
	});
	// A browse that stays up is a healthy one, so the backoff resets once it has clearly survived.
	setTimeout(() => {
		if (watcher) {
			restartDelay = MIN_RESTART_DELAY_MS;
		}
	}, HEALTHY_AFTER_MS);
};

const discover = () => {
	return [...peers.values()];
};

const onConnection = (socket, module) => {
	// A late joiner has missed every change emitted before it connected, and emitChanged suppresses a
	// repeat of the last payload, so the current list is replayed on connection rather than left until
	// the next time something on the network moves.
	if (socket.isAuthenticated && socket.isAdmin) {
		socket.emit('host:discovery', discover());
	}

	socket.on('host:discovery:fetch', () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		socket.emit('host:discovery', discover());
	});
};

const register = (module) => {
	onChange = () => {
		const list = discover();
		module.setState('discovery', list);
		module.emitChanged('host:discovery', list, {
			sortArrays: true,
			filter: (socket) => { return socket.isAuthenticated && socket.isAdmin; }
		});
	};
	watch();
};

export default {
	name: 'discovery',
	register,
	onConnection
};

export { discover, splitFields, parseTxt, applyLine, toPeer, serviceKey };
