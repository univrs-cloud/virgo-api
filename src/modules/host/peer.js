import crypto from 'crypto';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { io as ioClient } from 'socket.io-client';
import si from 'systeminformation';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as database from '../../database/index.js';
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
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_CHECK_TIMEOUT_MS = 5000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const TRAEFIK_CONFIG_PATH = '/messier/apps/traefik/config';
const PEER_ROUTE_PREFIX = 'peer.';

let hostModule = null;
let clock = null;
let clockQueue = Promise.resolve();
let reconciling = false;
let reconcileAgain = false;
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
		if (!await database.ensureOpen()) {
			return 0;
		}

		clock = (Number((await DataService.getConfiguration()).peerClock) || 0);
	}

	return clock;
};

const withClock = (task) => {
	const run = clockQueue.then(task);
	clockQueue = run.catch(() => {});
	return run;
};

const advanceClock = (received) => {
	return withClock(async () => {
		const next = Math.max(await loadClock(), (Number(received) || 0)) + 1;
		if (!await DataService.setConfiguration('peerClock', next)) {
			throw new Error('Could not store the peer clock.');
		}

		clock = next;
		return next;
	});
};

const observeClock = (received) => {
	return withClock(async () => {
		const value = (Number(received) || 0);
		if (value > await loadClock() && await DataService.setConfiguration('peerClock', value)) {
			clock = value;
		}
	});
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

const withoutKeys = (peers) => {
	return peers.map(({ key, ...peer }) => { return peer; });
};

const getClusterDomain = async () => {
	const { hostname, fqdn } = await si.osInfo();
	const prefix = `${hostname}.`;
	const domainName = (hostname && String(fqdn || '').startsWith(prefix) ? fqdn.slice(prefix.length).toLowerCase() : '');
	return (domainName.split('.').length >= 3 ? domainName : null);
};

const peerRoute = (id, name, address, clusterDomain) => {
	const fqdn = `${name}.${clusterDomain}`.toLowerCase();
	const router = `peer-${id}`;
	return `tcp:
  routers:
    ${router}:
      rule: 'HostSNI(\`${fqdn}\`) || HostSNIRegexp(\`^.+\\.${fqdn.replace(/\./g, '\\.')}$\`)'
      entryPoints:
        - "https"
      service: "${router}"
      tls:
        passthrough: true
  serversTransports:
    ${router}:
      proxyProtocol:
        version: 2
  services:
    ${router}:
      loadBalancer:
        serversTransport: "${router}"
        servers:
          - address: "${address}:443"
`;
};

const syncPeerRoutes = async () => {
	try {
		const clusterDomain = await getClusterDomain();
		const own = await ownAddresses();
		const wanted = new Map();
		for (const peer of (clusterDomain ? await readConfiguration() : [])) {
			if (!LABEL_PATTERN.test(peer.name || '') || !peer.address || own.includes(peer.address)) {
				continue;
			}

			const id = String(peer.id).toLowerCase().replace(/[^a-z0-9-]/g, '-');
			wanted.set(`${PEER_ROUTE_PREFIX}${id}.yml`, peerRoute(id, peer.name, peer.address, clusterDomain));
		}

		const files = await fs.readdir(TRAEFIK_CONFIG_PATH);
		for (const file of files.filter((entry) => { return entry.startsWith(PEER_ROUTE_PREFIX) && !wanted.has(entry); })) {
			await fs.rm(path.join(TRAEFIK_CONFIG_PATH, file), { force: true });
		}

		for (const [file, content] of wanted) {
			const filePath = path.join(TRAEFIK_CONFIG_PATH, file);
			if (await fs.readFile(filePath, 'utf8').catch(() => { return null; }) !== content) {
				await fs.writeFile(filePath, content, 'utf8');
			}
		}
	} catch (error) {
		console.warn(`Could not update the routes to adopted nodes: ${error.message}`);
	}
};

const refreshPeers = async () => {
	const own = await ownAddresses();
	const visible = discovery.discover();
	const updates = new Map();
	for (const peer of await readConfiguration()) {
		const node = visible.find((entry) => { return entry.id === peer.id; });
		const name = (LABEL_PATTERN.test(node?.name || '') ? node.name : peer.name);
		const address = (node?.address && !own.includes(node.address) ? node.address : peer.address);
		if (name !== peer.name || address !== peer.address) {
			updates.set(peer.id, { name, address });
		}
	}

	if (!updates.size) {
		return;
	}

	const peers = await readConfiguration();
	await DataService.setConfiguration('peers', peers.map((peer) => { return (updates.has(peer.id) ? { ...peer, ...updates.get(peer.id) } : peer); }));
	await publishPeers();
};

const publishPeers = async () => {
	const peers = withoutKeys(await readConfiguration());
	hostModule?.setState('peers', peers);
	hostModule?.emitChanged('host:peers', peers, { audience: 'admin' });
	hostModule?.eventEmitter.emit('host:peers:updated', peers.map((peer) => { return peer.id; }));
	await syncPeerRoutes();
};

const forgetPeer = async (nodeId) => {
	const peers = await readConfiguration();
	await DataService.setConfiguration('peers', peers.filter((entry) => { return entry.id !== nodeId; }));
	await pruneRemovals();
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
};

/** Adopting one node does not preclude adopting another, so this appends rather than replaces. */
const savePeer = async ({ id, name, address, key }, receivedClock) => {
	const pairedClock = await advanceClock(receivedClock);
	const peers = await readConfiguration();
	const peer = { id, name, address, key, pairedAt: new Date().toISOString(), pairedClock };
	await DataService.setConfiguration('peers', [...peers.filter((entry) => { return entry.id !== id; }), peer]);
	await clearRemoval(id);
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
	await retireGhosts(peer);
};

const removePeer = async (nodeId, removedClock, confirmedBy = []) => {
	const stamp = (Number(removedClock) > 0 ? Number(removedClock) : await advanceClock());
	await observeClock(stamp);
	await forgetPeer(nodeId);
	await recordRemoval(nodeId, stamp, confirmedBy);
	return stamp;
};

const retireGhosts = async (peer) => {
	const visible = discovery.discover();
	const ghosts = (await readConfiguration()).filter((entry) => {
		return entry.id !== peer.id && entry.address === peer.address && !visible.some((node) => { return node.id === entry.id; });
	});
	for (const ghost of ghosts) {
		console.log(`${ghost.name || ghost.address} was replaced by ${peer.name || peer.address} at the same address; removing it.`);
		await removePeer(ghost.id);
	}
};

const clientAddress = (connection) => {
	return String(connection.handshake?.address || '').replace(/^::ffff:/, '');
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

				const source = clientAddress(connection);
				const advertised = discovery.discover().find((node) => { return node.id === request.id; });
				if (!advertised || ![advertised.address, (advertised.holdsVirtualIp ? advertised.virtualIp : null)].filter(Boolean).includes(source)) {
					acknowledge({ status: 'failed', message: 'Pairing was refused: that node is not on the network at this address.' });
					return;
				}

				if (request.adopt) {
					await dropStalePeers();
				}

				if (await findPeer(request.id)) {
					acknowledge({ status: 'failed', message: 'Pairing was refused: that node is already adopted. Remove it first to pair again.' });
					return;
				}

				if (request.adopt) {
					const current = await virtualIpConfiguration();
					if ((await readConfiguration()).length) {
						acknowledge({ status: 'failed', message: `${self.name || self.address} already belongs to a cluster. Remove its adopted nodes first.` });
						return;
					}

					if (current?.address && current.address !== request.virtualIp?.address) {
						acknowledge({ status: 'failed', message: `${self.name || self.address} has a different virtual IP (${current.address}).` });
						return;
					}
				}

				const key = (offered ? request.key : pairingKey(request.id));
				await savePeer({ id: request.id, name: request.name, address: advertised.address, key }, request.clock);
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
	const peers = await readConfiguration();
	const results = await Promise.allSettled(peers.map((peer) => { return call(peer.id, event, payload); }));
	results.forEach((result, index) => {
		if (result.status === 'rejected') {
			console.warn(`Could not tell ${peers[index].name || peers[index].address} about ${event}: ${result.reason.message}`);
		}
	});
};

/** One call: the node with the smaller id mints the key, and both keep it. */
const pairWith = async (nodeId, address, adopting = false) => {
	const self = await describeSelf();
	const offered = (self.id < nodeId ? pairingKey(nodeId) : undefined);
	// Sent as well as read back: the node holding the address is the one that adopts, so the config
	// usually travels outward. Both directions are carried so it works whichever side initiates.
	const configured = await virtualIpConfiguration();
	const connection = connectToPeer(address, { mode: 'pair' });
	try {
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error('That node did not answer.')); }, (adopting ? REQUEST_TIMEOUT_MS + STALE_CHECK_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
			connection.on('connect_error', () => { clearTimeout(timer); reject(new Error('Could not reach that node.')); });
			connection.on('connect', async () => {
				connection.emit('pair:request', { ...self, key: offered, virtualIp: configured, adopt: adopting, clock: await loadClock() }, (answer) => {
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

const pairOnce = (nodeId, address, adopting = false) => {
	if (!pairing.has(nodeId)) {
		pairing.set(nodeId, pairWith(nodeId, address, adopting).finally(() => { pairing.delete(nodeId); }));
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
	const node = { id: newcomer.id, name: newcomer.name, address: newcomer.address };
	const results = await Promise.allSettled(others.map((peer) => { return call(peer.id, 'peer:introduce', { node }, INTRODUCE_TIMEOUT_MS); }));
	return others.filter((peer, index) => {
		if (results[index].status === 'fulfilled') {
			return false;
		}

		console.warn(`Could not introduce ${newcomer.name || newcomer.address} to ${peer.name || peer.address}: ${results[index].reason.message}`);
		return true;
	}).map((peer) => { return peer.name || peer.address; });
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

	const configured = await virtualIpConfiguration();
	if (peer.virtualIp && peer.virtualIp !== configured?.address) {
		throw new Error(`${peer.name || peer.address} has a different virtual IP (${peer.virtualIp}).`);
	}

	await module.updateJobProgress(job, `Adopting ${peer.name || peer.address}...`);
	const node = await pairOnce(peer.id, peer.address, true);
	await module.updateJobProgress(job, `Introducing ${node.name || peer.address} to the other nodes...`);
	const failed = await introduce(node.id);
	if (failed.length) {
		return `Adopted ${node.name || peer.address}. ${failed.join(', ')} could not be reached and will pair with it when they next see this node.`;
	}

	return `Adopted ${node.name || peer.address}.`;
};

const stillAdopted = async (address, nodeId, timeout = REQUEST_TIMEOUT_MS) => {
	const connection = connectToPeer(address, { mode: 'call', nodeId });
	try {
		return await new Promise((resolve) => {
			const timer = setTimeout(() => { resolve(true); }, timeout);
			connection.on('connect', () => { clearTimeout(timer); resolve(true); });
			connection.on('connect_error', (error) => { clearTimeout(timer); resolve(error?.data?.reason !== 'unknown'); });
		});
	} finally {
		connection.close();
	}
};

const dropStalePeers = async () => {
	const self = await describeSelf();
	const own = await ownAddresses();
	const visible = discovery.discover();
	const peers = (await readConfiguration()).map((peer) => {
		return { peer, address: visible.find((node) => { return node.id === peer.id; })?.address };
	}).filter(({ address }) => { return address && !own.includes(address); });
	const results = await Promise.all(peers.map(({ address }) => { return stillAdopted(address, self.id, STALE_CHECK_TIMEOUT_MS); }));
	for (const [index, adopted] of results.entries()) {
		if (!adopted) {
			console.log(`${peers[index].peer.name || peers[index].peer.address} no longer has this node adopted; removing it.`);
			await forgetPeer(peers[index].peer.id);
		}
	}
};

/** Removal only ever reaches a node that is up. Remove a node while it is powered off and it comes
 * back still believing it is adopted, holding a key the other side has already forgotten — so the one
 * left behind has to notice for itself.
 *
 * Being told "I do not know you" is the only answer that removes anything. Unreachable, timed out and
 * refused all leave the pairing alone: not hearing back is not the same as having been removed, and
 * treating it that way would drop a peer every time the other node reboots. */
const reconcile = async (peer, address, nodeId) => {
	if (await stillAdopted(address, nodeId)) {
		return true;
	}

	console.log(`${peer.name || peer.address} no longer has this node adopted; removing it.`);
	await forgetPeer(peer.id);
	return false;
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

const scheduleReconcile = async () => {
	if (reconciling) {
		reconcileAgain = true;
		return;
	}

	reconciling = true;
	try {
		do {
			reconcileAgain = false;
			await reconcileVisible(discovery.discover());
		} while (reconcileAgain);
		await refreshPeers();
		await syncPeerRoutes();
	} catch (error) {
		console.warn(`Could not reconcile adopted nodes: ${error.message}`);
	} finally {
		reconciling = false;
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
	const others = await readConfiguration();
	const results = await Promise.allSettled(others.map((other) => { return call(other.id, 'peer:forget', { id: peer.id, removedClock }); }));
	const told = [];
	for (const [index, result] of results.entries()) {
		if (result.status === 'fulfilled') {
			await confirmRemovals(others[index].id, [peer.id]);
			told.push(others[index].id);
		} else {
			console.warn(`Could not tell ${others[index].name || others[index].address} that ${peer.name || peer.address} was removed: ${result.reason.message}`);
		}
	}

	if (told.length > 1) {
		const confirmations = await Promise.allSettled(told.map((id) => { return call(id, 'peer:forget', { id: peer.id, removedClock, confirmedBy: told }); }));
		confirmations.filter((result) => { return result.status === 'rejected'; }).forEach((result) => {
			console.warn(`Could not confirm the removal of ${peer.name || peer.address}: ${result.reason.message}`);
		});
	}

	return `${peer.name || peer.address} removed.`;
};

const onConnection = (socket, module) => {
	// emitChanged suppresses a repeat of the last payload, so a browser connecting after the last
	// change would otherwise see nothing until the next adoption.
	if (socket.isAuthenticated && socket.isAdmin) {
		readConfiguration().then((peers) => { socket.emit('host:peers', withoutKeys(peers)); });
	}

};

const register = (module) => {
	hostModule = module;
	attachNamespace();
	publishPeers();
	module.eventEmitter.on('host:discovery:updated', () => { scheduleReconcile(); });
	module.eventEmitter.on('host:network:identifier:updated', () => { syncPeerRoutes(); });
	setInterval(() => {
		reconciled.clear();
		scheduleReconcile();
	}, RECONCILE_INTERVAL_MS);
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
