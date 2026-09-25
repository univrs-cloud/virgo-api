import crypto from 'crypto';
import https from 'https';
import { io as ioClient } from 'socket.io-client';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as socket from '../../socket.js';
import * as advertisement from './advertisement.js';
import * as discovery from './discovery.js';
import { getOwnAddress } from '../../utils/network.js';

const NAMESPACE = '/peer';
const KEY_BYTES = 32;
const REQUEST_TIMEOUT_MS = 15000;
const INTRODUCE_TIMEOUT_MS = REQUEST_TIMEOUT_MS * 2;
const PAIRING_KEY_TTL_MS = REQUEST_TIMEOUT_MS * 2;
const ADOPTION_GRACE_MS = 60000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

let hostModule = null;
let clock = null;
const reconciled = new Set();
const pairing = new Map();
const pairingKeys = new Map();

const sign = (key, nonce) => {
	return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(String(nonce)).digest('hex');
};

const matches = (first, second) => {
	const a = Buffer.from(String(first || ''), 'utf8');
	const b = Buffer.from(String(second || ''), 'utf8');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const readConfiguration = async () => {
	return (await DataService.getConfiguration()).peers || [];
};

const findPeer = async (nodeId) => {
	return (await readConfiguration()).find((peer) => { return peer.id === nodeId; }) || null;
};

const loadClock = async () => {
	if (clock === null) {
		clock = (Number((await DataService.getConfiguration()).peerClock) || 0);
	}

	return clock;
};

const advanceClock = async (received) => {
	await loadClock();
	clock = Math.max(clock, (Number(received) || 0)) + 1;
	await DataService.setConfiguration('peerClock', clock);
	return clock;
};

const observeClock = async (received) => {
	await loadClock();
	if ((Number(received) || 0) > clock) {
		clock = Number(received);
		await DataService.setConfiguration('peerClock', clock);
	}
};

const pairingKey = (nodeId) => {
	const current = pairingKeys.get(nodeId);
	if (current && current.expires > Date.now()) {
		return current.key;
	}

	const key = crypto.randomBytes(KEY_BYTES).toString('hex');
	pairingKeys.set(nodeId, { key, expires: Date.now() + PAIRING_KEY_TTL_MS });
	return key;
};

const readRemoved = async () => {
	return (await DataService.getConfiguration()).removedPeers || [];
};

const pruneRemovals = async () => {
	const peerIds = (await readConfiguration()).map((peer) => { return peer.id; });
	const removed = await readRemoved();
	const kept = removed.filter((entry) => {
		return !peerIds.every((id) => { return (entry.confirmedBy || []).includes(id); });
	});
	if (kept.length !== removed.length) {
		await DataService.setConfiguration('removedPeers', kept);
	}
};

const recordRemoval = async (nodeId, removedClock, confirmedBy) => {
	const removed = await readRemoved();
	const existing = removed.find((entry) => { return entry.id === nodeId; });
	const entry = {
		id: nodeId,
		clock: Math.max((Number(existing?.clock) || 0), removedClock),
		confirmedBy: [...new Set([...(existing?.confirmedBy || []), ...confirmedBy])]
	};
	await DataService.setConfiguration('removedPeers', [...removed.filter((item) => { return item.id !== nodeId; }), entry]);
	await pruneRemovals();
};

const confirmRemovals = async (peerId, nodeIds) => {
	if (!nodeIds.length) {
		return;
	}

	const removed = await readRemoved();
	const updated = removed.map((entry) => {
		return (nodeIds.includes(entry.id) ? { ...entry, confirmedBy: [...new Set([...(entry.confirmedBy || []), peerId])] } : entry);
	});
	await DataService.setConfiguration('removedPeers', updated);
	await pruneRemovals();
};

const clearRemoval = async (nodeId) => {
	const removed = await readRemoved();
	if (removed.some((entry) => { return entry.id === nodeId; })) {
		await DataService.setConfiguration('removedPeers', removed.filter((entry) => { return entry.id !== nodeId; }));
	}
};

/** Only what a peer needs to claim the address later, never the runtime state. */
const virtualIpConfiguration = async () => {
	const { virtualIp } = await DataService.getConfiguration();
	return (virtualIp?.address ? { address: virtualIp.address, netmask: virtualIp.netmask } : null);
};

/** The address is this node's own, with the virtual IP excluded — that address moves between nodes, so
 * a peer that stored it would be pointed at whichever node holds it rather than at this one. */
const describeSelf = async () => {
	const { virtualIp } = await DataService.getConfiguration();
	return {
		id: await advertisement.getNodeId(),
		name: (hostModule?.getState('system')?.osInfo?.hostname || ''),
		address: await getOwnAddress(virtualIp?.address)
	};
};

/** Both this node's own addresses. A peer address that turns out to be ours is defensive rather than
 * expected: a node that publishes no address TXT is resolved by avahi to whatever answers, which is
 * the virtual IP, and that address may since have moved here. */
const ownAddresses = async () => {
	const { virtualIp } = await DataService.getConfiguration();
	return [await getOwnAddress(virtualIp?.address), virtualIp?.address].filter(Boolean);
};

/** Discovery knows where a peer is right now; the stored address is only where it was when adopted.
 * Returns null rather than this node's own address: dialling ourselves would answer a question about
 * the peer with our own state, which reads as a confident wrong answer. */
const resolveAddress = async (peer) => {
	const address = (discovery.discover().find((node) => { return node.id === peer.id; })?.address || peer.address);
	return (address && !(await ownAddresses()).includes(address) ? address : null);
};

const publishPeers = async () => {
	const peers = await readConfiguration();
	hostModule?.setState('peers', peers);
	hostModule?.emitChanged('host:peers', peers, { audience: 'admin' });
	hostModule?.eventEmitter.emit('host:peers:updated', peers.map((peer) => { return peer.id; }));
};

const forgetPeer = async (nodeId) => {
	const peers = await readConfiguration();
	await DataService.setConfiguration('peers', peers.filter((entry) => { return entry.id !== nodeId; }));
	await pruneRemovals();
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
};

/** Adopting one node does not preclude adopting another, so this appends rather than replaces. A node
 * already on the list is refreshed in place — re-adopting is how a peer that was rebuilt gets a new
 * key without first being removed. */
const savePeer = async ({ id, name, address, key }, receivedClock) => {
	const pairedClock = await advanceClock(receivedClock);
	const peers = await readConfiguration();
	const peer = { id, name, address, key, pairedAt: new Date().toISOString(), pairedClock };
	await DataService.setConfiguration('peers', [...peers.filter((entry) => { return entry.id !== id; }), peer]);
	await clearRemoval(id);
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
};

const removePeer = async (nodeId, removedClock, confirmedBy = []) => {
	const stamp = (Number(removedClock) > 0 ? Number(removedClock) : await advanceClock());
	await observeClock(stamp);
	await forgetPeer(nodeId);
	await recordRemoval(nodeId, stamp, confirmedBy);
	return stamp;
};

const connectToPeer = (address, auth) => {
	return ioClient(`https://${address}:${config.server.port}${NAMESPACE}`, {
		path: '/api',
		agent: new https.Agent({ rejectUnauthorized: false }),
		rejectUnauthorized: false,
		transports: ['websocket'],
		reconnection: false,
		auth
	});
};

const attachNamespace = () => {
	const namespace = socket.getIO().of(NAMESPACE);
	namespace.use(async (connection, next) => {
		const { mode, nodeId } = connection.handshake.auth || {};
		// Adoption carries no credential — there is none yet — and can do exactly one thing: ask to be
		// adopted. Everything else needs the key that adoption hands out.
		if (mode === 'pair') {
			connection.identity = { mode: 'pair' };
			next();
			return;
		}

		const peer = (mode === 'call' ? await findPeer(nodeId) : null);
		if (!peer) {
			// The caller uses this to tell "you removed me" apart from "I could not reach you", so it
			// has to say which. It reveals only that an id is not adopted, to someone who already
			// knows the id.
			const error = new Error('Peer authentication failed.');
			error.data = { reason: 'unknown' };
			next(error);
			return;
		}

		connection.identity = { mode: 'call', peer };
		next();
	});

	namespace.on('connection', (connection) => {
		if (connection.identity.mode === 'pair') {
			connection.on('pair:request', async (request, acknowledge) => {
				const self = await describeSelf();
				const offered = (request?.id < self.id && KEY_PATTERN.test(String(request.key || '')));
				if (!request?.id || request.id === self.id) {
					acknowledge({ status: 'failed', message: 'Pairing was refused.' });
					return;
				}

				const key = (offered ? request.key : pairingKey(request.id));
				await savePeer({ id: request.id, name: request.name, address: request.address, key }, request.clock);
				if (request.virtualIp?.address) {
					hostModule?.eventEmitter.emit('host:peer:virtualIp:received', request.virtualIp);
				}

				// The virtual IP travels with the adoption. Without it the adopting node has no address
				// of its own to take over later — it can see this one holds an address, but not which
				// address it would be claiming or on what prefix.
				acknowledge({ status: 'ok', node: self, key: (offered ? undefined : key), virtualIp: await virtualIpConfiguration(), clock: await loadClock() });
			});
			return;
		}

		// A recognised id is not proof. Every call carries a token over this connection's nonce, so the
		// key authorises the action rather than merely knowing whose id to claim.
		const nonce = crypto.randomBytes(16).toString('hex');
		const verify = async (payload) => {
			if (!matches(payload?.token, sign(connection.identity.peer.key, nonce))) {
				return false;
			}

			await observeClock(payload.clock);
			return true;
		};
		connection.on('peer:remove', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			await forgetPeer(connection.identity.peer.id);
			acknowledge({ status: 'ok' });
		});
		connection.on('peer:introduce', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			if (!payload?.node?.id || !payload?.node?.address) {
				acknowledge({ status: 'failed', message: 'Nothing to introduce.' });
				return;
			}

			const joined = await joinIntroduced(payload.node);
			acknowledge(joined ? { status: 'ok', clock: await loadClock() } : { status: 'failed', message: `Could not pair with ${payload.node.name || payload.node.address}.` });
		});
		connection.on('peer:forget', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			const self = await describeSelf();
			if (payload?.id && payload.id !== self.id && payload.id !== connection.identity.peer.id) {
				await removePeer(payload.id, payload.removedClock, [connection.identity.peer.id, ...(Array.isArray(payload.confirmedBy) ? payload.confirmedBy : [])]);
			}

			acknowledge({ status: 'ok', clock: await loadClock() });
		});
		connection.on('peer:list', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			const peers = (await readConfiguration()).map((peer) => {
				return { id: peer.id, name: peer.name, address: peer.address, pairedClock: (Number(peer.pairedClock) || 0) };
			});
			const removed = (await readRemoved()).map((entry) => { return { id: entry.id, clock: (Number(entry.clock) || 0) }; });
			acknowledge({ status: 'ok', peers, removed, clock: await loadClock() });
		});
		connection.on('virtualIp:configure', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			// Whether this is allowed is decided where the address lives, not here: a node holding it
			// refuses to be rewritten.
			hostModule?.eventEmitter.emit('host:peer:virtualIp:configure', payload.virtualIp);
			acknowledge({ status: 'ok' });
		});
		connection.on('virtualIp:current', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			acknowledge({ status: 'ok', virtualIp: await virtualIpConfiguration() });
		});
		connection.on('virtualIp:promote', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			try {
				await hostModule.addJob('host:network:virtualIp:promote', { username: connection.identity.peer.name || 'peer' });
				acknowledge({ status: 'ok' });
			} catch (error) {
				acknowledge({ status: 'failed', message: 'Could not take the virtual IP over.' });
			}
		});
		connection.on('virtualIp:release', async (payload, acknowledge) => {
			if (!await verify(payload)) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			// The only thing a peer may ask for, and only ever to let go — never to take. Recorded under
			// the asking node's name so the job history shows which node the migration came from; the
			// admin who started it is on that node.
			try {
				await hostModule.addJob('host:network:virtualIp:release', { username: connection.identity.peer.name || 'peer' });
				acknowledge({ status: 'ok' });
			} catch (error) {
				acknowledge({ status: 'failed', message: 'Could not release the virtual IP.' });
			}
		});
		connection.emit('challenge', nonce);
	});

	return namespace;
};

/** The adopted node that discovery says is holding this address, if it is one we can command. A node
 * holding it that was never adopted cannot be asked to let go — only powered off. */
const findHolder = async (address) => {
	const holder = discovery.discover().find((node) => { return node.virtualIp === address && node.holdsVirtualIp; });
	return (holder ? findPeer(holder.id) : null);
};

/** Opened only when something has to be said to a peer, and closed again straight after. Whether a peer
 * is up is answered by mDNS, so there is nothing for a standing connection to add. */
const call = async (peerId, event, payload = {}, timeout = REQUEST_TIMEOUT_MS) => {
	const peer = await findPeer(peerId);
	if (!peer) {
		throw new Error(`That node is not adopted.`);
	}

	const self = await describeSelf();
	const address = await resolveAddress(peer);
	if (!address) {
		throw new Error(`Could not reach ${peer.name || peer.address}.`);
	}

	const connection = connectToPeer(address, { mode: 'call', nodeId: self.id });
	const sent = await loadClock();
	try {
		const answer = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error(`${peer.name || peer.address} did not answer.`)); }, timeout);
			connection.on('connect_error', () => { clearTimeout(timer); reject(new Error(`Could not reach ${peer.name || peer.address}.`)); });
			connection.on('challenge', (nonce) => {
				connection.emit(event, { ...payload, token: sign(peer.key, nonce), clock: sent }, (response) => {
					clearTimeout(timer);
					(response?.status === 'ok' ? resolve(response) : reject(new Error(response?.message || `${peer.name || peer.address} refused.`)));
				});
			});
		});
		await observeClock(answer?.clock);
		return answer;
	} finally {
		connection.close();
	}
};

/** Says the same thing to every adopted node. Unreachable peers are logged and skipped — this runs
 * behind operations that must not fail because another node is switched off. */
const broadcast = async (event, payload = {}) => {
	for (const peer of await readConfiguration()) {
		try {
			await call(peer.id, event, payload);
		} catch (error) {
			console.warn(`Could not tell ${peer.name || peer.address} about ${event}: ${error.message}`);
		}
	}
};

/** One call: the node with the smaller id mints the key, and both keep it. */
const pairWith = async (nodeId, address) => {
	const self = await describeSelf();
	const offered = (self.id < nodeId ? pairingKey(nodeId) : undefined);
	// Sent as well as read back: the node holding the address is the one that adopts, so the config
	// usually travels outward. Both directions are carried so it works whichever side initiates.
	const configured = await virtualIpConfiguration();
	const connection = connectToPeer(address, { mode: 'pair' });
	try {
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error('That node did not answer.')); }, REQUEST_TIMEOUT_MS);
			connection.on('connect_error', () => { clearTimeout(timer); reject(new Error('Could not reach that node.')); });
			connection.on('connect', async () => {
				connection.emit('pair:request', { ...self, key: offered, virtualIp: configured, clock: await loadClock() }, (answer) => {
					clearTimeout(timer);
					(answer?.status === 'ok' ? resolve(answer) : reject(new Error(answer?.message || 'Pairing was refused.')));
				});
			});
		});
		if (response.node?.id !== nodeId) {
			throw new Error('A different node answered.');
		}

		const key = (response.key || offered);
		if (!KEY_PATTERN.test(String(key || ''))) {
			throw new Error('Pairing was refused.');
		}

		await savePeer({ id: response.node.id, name: response.node.name, address, key }, response.clock);
		if (response.virtualIp?.address) {
			hostModule?.eventEmitter.emit('host:peer:virtualIp:received', response.virtualIp);
		}

		return response.node;
	} finally {
		connection.close();
	}
};

const pairOnce = (nodeId, address) => {
	if (!pairing.has(nodeId)) {
		pairing.set(nodeId, pairWith(nodeId, address).finally(() => { pairing.delete(nodeId); }));
	}

	return pairing.get(nodeId);
};

const joinIntroduced = async (node) => {
	const self = await describeSelf();
	if (node.id === self.id) {
		return true;
	}

	const address = (discovery.discover().find((candidate) => { return candidate.id === node.id; })?.address || node.address);
	try {
		await pairOnce(node.id, address);
		return true;
	} catch (error) {
		console.warn(`Could not pair with ${node.name || address}: ${error.message}`);
		return false;
	}
};

const introduce = async (nodeId) => {
	const newcomer = await findPeer(nodeId);
	const others = (await readConfiguration()).filter((peer) => { return peer.id !== nodeId; });
	const failed = [];
	for (const peer of others) {
		try {
			await call(peer.id, 'peer:introduce', { node: { id: newcomer.id, name: newcomer.name, address: newcomer.address } }, INTRODUCE_TIMEOUT_MS);
		} catch (error) {
			console.warn(`Could not introduce ${newcomer.name || newcomer.address} to ${peer.name || peer.address}: ${error.message}`);
			failed.push(peer.name || peer.address);
		}
	}

	return failed;
};

const adopt = async (job, module) => {
	const { config } = job.data;
	if (await findPeer(config.peerId)) {
		throw new Error(`That node is already adopted.`);
	}

	const peer = discovery.discover().find((candidate) => { return candidate.id === config.peerId; });
	if (!peer) {
		throw new Error('That node is no longer on the network.');
	}

	if (!peer.setupCompleted) {
		throw new Error(`${peer.name || peer.address} has not finished its own setup yet.`);
	}

	await module.updateJobProgress(job, `Adopting ${peer.name || peer.address}...`);
	const node = await pairOnce(peer.id, peer.address);
	await module.updateJobProgress(job, `Introducing ${node.name || peer.address} to the other nodes...`);
	const failed = await introduce(node.id);
	if (failed.length) {
		return `Adopted ${node.name || peer.address}. ${failed.join(', ')} could not be reached and will pair with it when they next see this node.`;
	}

	return `Adopted ${node.name || peer.address}.`;
};

/** Removal only ever reaches a node that is up. Remove a node while it is powered off and it comes
 * back still believing it is adopted, holding a key the other side has already forgotten — so the one
 * left behind has to notice for itself.
 *
 * Being told "I do not know you" is the only answer that removes anything. Unreachable, timed out and
 * refused all leave the pairing alone: not hearing back is not the same as having been removed, and
 * treating it that way would drop a peer every time the other node reboots. */
const reconcile = async (peer, address, nodeId) => {
	const connection = connectToPeer(address, { mode: 'call', nodeId });
	try {
		const adopted = await new Promise((resolve) => {
			const timer = setTimeout(() => { resolve(true); }, REQUEST_TIMEOUT_MS);
			connection.on('connect', () => { clearTimeout(timer); resolve(true); });
			connection.on('connect_error', (error) => { clearTimeout(timer); resolve(error?.data?.reason !== 'unknown'); });
		});
		if (adopted) {
			return true;
		}

		console.log(`${peer.name || peer.address} no longer has this node adopted; removing it.`);
		await forgetPeer(peer.id);
		return false;
	} finally {
		connection.close();
	}
};

/** A virtual IP that changed while this node was off never arrived, and the holder has no reason to
 * say it again. Discovery says which node holds an address and which address it is, so a disagreement
 * with what this node has is visible without asking — and only then is the holder asked for the
 * netmask, which is not advertised. */
const reconcileVirtualIp = async (peer, node) => {
	const configured = await virtualIpConfiguration();
	if (!node.holdsVirtualIp || node.virtualIp === configured?.address) {
		return;
	}

	try {
		const answer = await call(peer.id, 'virtualIp:current');
		hostModule?.eventEmitter.emit('host:peer:virtualIp:configure', answer.virtualIp);
	} catch (error) {
		console.warn(`Could not read the virtual IP from ${peer.name || peer.address}: ${error.message}`);
	}
};

const reconcilePeers = async (peer, self) => {
	let answer = null;
	try {
		answer = await call(peer.id, 'peer:list');
	} catch (error) {
		console.warn(`Could not read the adopted nodes of ${peer.name || peer.address}: ${error.message}`);
		return;
	}

	for (const removal of (answer.removed || [])) {
		const known = await findPeer(removal.id);
		if (known && removal.id !== peer.id && (Number(removal.clock) || 0) > (Number(known.pairedClock) || 0)) {
			console.log(`${known.name || known.address} was removed while this node was away; forgetting it.`);
			await removePeer(removal.id, removal.clock, [peer.id]);
		}
	}

	const listed = (answer.peers || []).map((entry) => { return entry.id; });
	await confirmRemovals(peer.id, (await readRemoved()).map((entry) => { return entry.id; }).filter((id) => { return !listed.includes(id); }));

	const removed = await readRemoved();
	const visible = discovery.discover();
	for (const candidate of (answer.peers || [])) {
		const tombstone = removed.find((entry) => { return entry.id === candidate.id; });
		const node = visible.find((entry) => { return entry.id === candidate.id; });
		if (candidate.id === self.id || await findPeer(candidate.id)) {
			continue;
		}

		if ((tombstone && (Number(tombstone.clock) || 0) > (Number(candidate.pairedClock) || 0)) || !node?.address || !node.setupCompleted) {
			continue;
		}

		console.log(`${candidate.name || node.address} was adopted while this node was away; pairing with it.`);
		try {
			await pairOnce(candidate.id, node.address);
		} catch (error) {
			console.warn(`Could not pair with ${candidate.name || node.address}: ${error.message}`);
		}
	}
};

/** Checked when a peer turns up on the network, which covers both sides of the case: this node
 * booting and seeing its peers, and a peer booting and being seen. Once per appearance — a peer that
 * stays visible is not re-checked, and going away is what arms the next check. */
const reconcileVisible = async (nodes) => {
	const visible = new Map(nodes.map((node) => { return [node.id, node]; }));
	reconciled.forEach((id) => {
		if (!visible.has(id)) {
			reconciled.delete(id);
		}
	});

	// Discovery changes whenever anything on the segment moves, and a node with nothing adopted — the
	// single-node case — has no reason to read its own addresses each time.
	const candidates = (await readConfiguration()).filter((peer) => {
		return visible.has(peer.id) && !reconciled.has(peer.id);
	});
	if (!candidates.length) {
		return;
	}

	const self = await describeSelf();
	const own = await ownAddresses();
	for (const peer of candidates) {
		const node = visible.get(peer.id);
		// Only an address discovery published for this node id, and never one of ours. The stored
		// address is not good enough here: it may predate the peer moving, and a wrong node answering
		// "I do not know you" is indistinguishable from the right one saying it.
		if (!node.address || own.includes(node.address)) {
			continue;
		}

		// The adopting node stores its side after the acknowledgement, so for a moment the node that
		// was just adopted knows the pairing and the adopter does not. Probing into that window would
		// undo the adoption that was still completing.
		const pairedAt = Date.parse(peer.pairedAt);
		if (Number.isFinite(pairedAt) && (Date.now() - pairedAt) < ADOPTION_GRACE_MS) {
			continue;
		}

		reconciled.add(peer.id);
		if (await reconcile(peer, node.address, self.id)) {
			await reconcileVirtualIp(peer, node);
			await reconcilePeers(peer, self);
		}
	}
};

/** One-sided by design: the node being removed is usually the one that has died. The virtual IP is
 * deliberately untouched — the address lives in the kernel, not in the pairing. */
const remove = async (job, module) => {
	const { config } = job.data;
	const peer = await findPeer(config.peerId);
	if (!peer) {
		throw new Error(`That node is not adopted.`);
	}

	await module.updateJobProgress(job, `Removing ${peer.name || peer.address}...`);
	// Best effort: a node that has died still has to be removable, so failing to reach it is not a
	// reason to leave it adopted here. When it does answer, both sides forget each other.
	try {
		await call(peer.id, 'peer:remove');
	} catch (error) {
		console.warn(`Could not tell ${peer.name || peer.address} it was removed: ${error.message}`);
	}

	const removedClock = await removePeer(peer.id);
	const told = [];
	for (const other of await readConfiguration()) {
		try {
			await call(other.id, 'peer:forget', { id: peer.id, removedClock });
			await confirmRemovals(other.id, [peer.id]);
			told.push(other.id);
		} catch (error) {
			console.warn(`Could not tell ${other.name || other.address} that ${peer.name || peer.address} was removed: ${error.message}`);
		}
	}

	for (const id of (told.length > 1 ? told : [])) {
		try {
			await call(id, 'peer:forget', { id: peer.id, removedClock, confirmedBy: told });
		} catch (error) {
			console.warn(`Could not confirm the removal of ${peer.name || peer.address}: ${error.message}`);
		}
	}

	return `${peer.name || peer.address} removed.`;
};

const onConnection = (socket, module) => {
	// emitChanged suppresses a repeat of the last payload, so a browser connecting after the last
	// change would otherwise see nothing until the next adoption.
	if (socket.isAuthenticated && socket.isAdmin) {
		readConfiguration().then((peers) => { socket.emit('host:peers', peers); });
	}

};

const register = (module) => {
	hostModule = module;
	attachNamespace();
	publishPeers();
	module.eventEmitter.on('host:discovery:updated', async (nodes) => {
		try {
			await reconcileVisible(nodes);
		} catch (error) {
			console.warn(`Could not reconcile adopted nodes: ${error.message}`);
		}
	});
};

export default {
	name: 'peer',
	commands: {
		'host:peer:remove': { job: 'host:peer:remove' },
		'host:peer:adopt': { job: 'host:peer:adopt' }
	},
	register,
	onConnection,
	call,
	broadcast,
	findHolder,
	jobs: {
		'host:peer:adopt': adopt,
		'host:peer:remove': remove
	}
};
