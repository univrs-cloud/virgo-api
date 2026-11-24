import crypto from 'crypto';
import fs from 'fs/promises';
import https from 'https';
import net from 'net';
import path from 'path';
import { io as ioClient } from 'socket.io-client';
import si from 'systeminformation';
import { execa } from 'execa';
import pkg from '../../../package.json' with { type: 'json' };
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as database from '../../database/index.js';
import * as socket from '../../socket.js';
import * as discovery from './discovery.js';
import { getOwnAddress, holdsAddress } from '../../utils/network.js';
import { getNodeId, isNodeId } from '../../utils/node_id.js';
import docker from '../../utils/docker_client.js';
import { createLog } from '../../utils/log.js';

const log = createLog('host:peer');

const NAMESPACE = '/peer';
const KEY_BYTES = 32;
const REQUEST_TIMEOUT_MS = 15000;
const PAIRING_KEY_TTL_MS = REQUEST_TIMEOUT_MS * 2;
const ADOPTION_GRACE_MS = 60000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_CHECK_TIMEOUT_MS = 5000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const VERSION_PATTERN = /^[0-9a-z.+-]{1,32}$/i;
const TRAEFIK_CONFIG_PATH = '/messier/apps/traefik/config';
const PEER_ROUTE_PREFIX = 'peer.';
const PIHOLE_DNSMASQ_PATH = '/messier/apps/pihole/dnsmasq.d';
const PIHOLE_PEERS_FILE = 'peers.conf';
const PIHOLE_LABELS = ['com.docker.compose.project=pihole', 'com.docker.compose.service=pihole'];
const EXTERNAL_EVENTS = ['peer:remove', 'replication:exchange', 'replication:verify'];
const ROUTINE_EVENTS = ['peer:list'];
const SSH_PORT = 22;
const REACH_TIMEOUT_MS = 5000;
const EXTERNAL_REQUEST_TTL_MS = 5 * 60 * 1000;
const EXTERNAL_REQUEST_LIMIT = 3;
const EXTERNAL_RETRY_MS = 60 * 1000;
const EXTERNAL_CLOSE_TIMEOUT_MS = 5000;
const PAIRING_JAIL = 'virgo-pairing';

let hostModule = null;
let clock = null;
let clockQueue = Promise.resolve();
let reconciling = false;
let reconcileAgain = false;
const reconciled = new Set();
const pairing = new Map();
const pairingKeys = new Map();
const externalRequests = new Map();
const requestTimes = new Map();

const describeVersion = (version) => {
	return (VERSION_PATTERN.test(String(version || '')) ? `version ${version}` : 'an older version');
};

const describeRequest = (request, source) => {
	const name = (LABEL_PATTERN.test(String(request?.name || '')) ? request.name : 'a node without a valid name');
	const id = (isNodeId(request?.id) ? request.id : 'no valid id');
	return `${name} (${id}) at ${source}`;
};

const reportProgress = (job, module, message) => {
	log.info(`${job.name}: ${message}`);
	return module.updateJobProgress(job, message);
};

const signCall = (key, nonce, event, body) => {
	return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(['call', nonce, event, body])).digest('hex');
};

const signReply = (key, nonce, event, body) => {
	return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(['reply', nonce, event, body])).digest('hex');
};

const readCall = (key, nonce, event, request) => {
	if (typeof request?.payload !== 'string' || !matches(request.token, signCall(key, nonce, event, request.payload))) {
		return null;
	}

	try {
		const payload = JSON.parse(request.payload);
		return (NONCE_PATTERN.test(String(payload?.replyNonce || '')) ? payload : null);
	} catch (error) {
		return null;
	}
};

const readReply = (key, nonce, event, response) => {
	if (typeof response?.payload !== 'string' || !matches(response.signature, signReply(key, nonce, event, response.payload))) {
		return null;
	}

	try {
		return JSON.parse(response.payload);
	} catch (error) {
		return null;
	}
};

const isSameVersion = (version) => {
	return String(version || '').toLowerCase() === String(pkg.version).toLowerCase();
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

const readExternalPeers = async () => {
	return (await DataService.getConfiguration()).externalPeers || [];
};

const findExternalPeer = async (nodeId) => {
	return (await readExternalPeers()).find((peer) => { return peer.id === nodeId; }) || null;
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
	const { clusterDomain } = await getNodeIdentity();
	return {
		id: await getNodeId(),
		name: (hostModule?.getState('system')?.osInfo?.hostname || ''),
		address: await getOwnAddress(virtualIp?.address),
		cluster: clusterDomain,
		version: pkg.version
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

const getNodeIdentity = async () => {
	const { hostname, fqdn } = await si.osInfo();
	const prefix = `${hostname}.`;
	const domainName = (hostname && String(fqdn || '').startsWith(prefix) ? fqdn.slice(prefix.length).toLowerCase() : '');
	return { hostname, clusterDomain: (domainName.split('.').length >= 3 ? domainName : null) };
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
http:
  routers:
    ${router}-acme:
      rule: '(Host(\`${fqdn}\`) || HostRegexp(\`^.+\\.${fqdn.replace(/\./g, '\\.')}$\`)) && PathPrefix(\`/.well-known/acme-challenge/\`)'
      entryPoints:
        - "http"
      priority: 1000
      service: "${router}-acme"
  services:
    ${router}-acme:
      loadBalancer:
        servers:
          - url: "http://${address}:80"
`;
};

const syncPeerRoutes = async () => {
	try {
		const { hostname, clusterDomain } = await getNodeIdentity();
		const own = await ownAddresses();
		const peers = (clusterDomain ? await readConfiguration() : []).filter((peer) => {
			return LABEL_PATTERN.test(peer.name || '') && peer.address && !own.includes(peer.address);
		});
		const wanted = new Map();
		for (const peer of peers) {
			const id = String(peer.id).toLowerCase().replace(/[^a-z0-9-]/g, '-');
			wanted.set(`${PEER_ROUTE_PREFIX}${id}.yml`, peerRoute(id, peer.name, peer.address, clusterDomain));
		}

		const files = await fs.readdir(TRAEFIK_CONFIG_PATH);
		for (const file of files.filter((entry) => { return entry.startsWith(PEER_ROUTE_PREFIX) && !wanted.has(entry); })) {
			await fs.rm(path.join(TRAEFIK_CONFIG_PATH, file), { force: true });
			log.info(`Removed the route file ${file}.`);
		}

		for (const [file, content] of wanted) {
			const filePath = path.join(TRAEFIK_CONFIG_PATH, file);
			if (await fs.readFile(filePath, 'utf8').catch(() => { return null; }) !== content) {
				await fs.writeFile(filePath, content, 'utf8');
				log.info(`Wrote the route file ${file}.`);
			}
		}

		await syncPiholeRecords(clusterDomain, hostname, peers);
	} catch (error) {
		log.warn(`Could not update the routes to adopted nodes:`, error);
	}
};

const syncPiholeRecords = async (clusterDomain, hostname, peers) => {
	try {
		if (!await holdsVirtualIp() || !await DataService.getApplication('pihole')) {
			return;
		}

		const { virtualIp } = await DataService.getConfiguration();
		const address = await getOwnAddress(virtualIp?.address);
		if (clusterDomain && !address) {
			return;
		}

		const records = [{ name: hostname, address }, ...peers];
		const content = (clusterDomain
			? records.map((record) => { return `address=/${`${record.name}.${clusterDomain}`.toLowerCase()}/${record.address}`; }).join('\n') + '\n'
			: null);
		const filePath = path.join(PIHOLE_DNSMASQ_PATH, PIHOLE_PEERS_FILE);
		if (await fs.readFile(filePath, 'utf8').catch(() => { return null; }) === content) {
			return;
		}

		if (content) {
			await fs.writeFile(filePath, content, 'utf8');
			log.info(`Wrote the Pi-hole addresses of ${records.length} node(s).`);
		} else {
			await fs.rm(filePath, { force: true });
			log.info('Removed the Pi-hole addresses of adopted nodes.');
		}

		const [container] = await docker.listContainers({ filters: { label: PIHOLE_LABELS } });
		if (container) {
			await docker.getContainer(container.Id).restart();
			log.info('Restarted Pi-hole to load the node addresses.');
		}
	} catch (error) {
		log.warn(`Could not update the Pi-hole addresses of adopted nodes:`, error);
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
			log.info(`Adopted node ${peer.name || peer.address} (${peer.id}) is now ${name || address} at ${address}.`);
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

const publishExternalPeers = async () => {
	const peers = withoutKeys(await readExternalPeers());
	hostModule?.setState('externalPeers', peers);
	hostModule?.emitChanged('host:peers:external', peers, { audience: 'admin' });
	hostModule?.eventEmitter.emit('host:peers:external:updated', peers.map((peer) => { return peer.id; }));
};

const saveExternalPeer = async ({ id, name, address, key, role }) => {
	const peers = await readExternalPeers();
	const peer = { id, name, address, key, role, pairedAt: new Date().toISOString() };
	await DataService.setConfiguration('externalPeers', [...peers.filter((entry) => { return entry.id !== id; }), peer]);
	log.info(`Saved external node ${name || address} (${id}) at ${address}, it is the ${role}.`);
	await publishExternalPeers();
};

const forgetExternalPeer = async (nodeId) => {
	const peers = await readExternalPeers();
	const peer = peers.find((entry) => { return entry.id === nodeId; });
	await DataService.setConfiguration('externalPeers', peers.filter((entry) => { return entry.id !== nodeId; }));
	log.info(`Forgot external node ${peer?.name || peer?.address || nodeId} (${nodeId}).`);
	await publishExternalPeers();
};

const publishRequests = () => {
	const requests = [...externalRequests.values()].map(({ id, name, address, version }) => { return { id, name, address, version }; });
	hostModule?.setState('peerRequests', requests);
	hostModule?.emitChanged('host:peer:requests', requests, { audience: 'admin' });
};

const forgetPeer = async (nodeId) => {
	const peers = await readConfiguration();
	const peer = peers.find((entry) => { return entry.id === nodeId; });
	await DataService.setConfiguration('peers', peers.filter((entry) => { return entry.id !== nodeId; }));
	log.info(`Forgot adopted node ${peer?.name || peer?.address || nodeId} (${nodeId}).`);
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
	log.info(`Saved adopted node ${name || address} (${id}) at ${address}.`);
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
		log.info(`${ghost.name || ghost.address} was replaced by ${peer.name || peer.address} at the same address; removing it.`);
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

const refuse = (message) => {
	return { status: 'failed', message };
};

const waitForClose = (connection) => {
	return new Promise((resolve) => {
		if (connection.disconnected) {
			resolve();
			return;
		}

		const timer = setTimeout(resolve, EXTERNAL_CLOSE_TIMEOUT_MS);
		connection.once('disconnect', () => { clearTimeout(timer); resolve(); });
	});
};

const canConnect = (address, port) => {
	return new Promise((resolve) => {
		const probe = net.connect({ host: address, port, timeout: REACH_TIMEOUT_MS });
		const finish = (isReachable) => {
			probe.destroy();
			log.info(`${address} port ${port} is ${(isReachable ? 'reachable' : 'not reachable')} from this node.`);
			resolve(isReachable);
		};
		probe.once('connect', () => { finish(true); });
		probe.once('timeout', () => { finish(false); });
		probe.once('error', () => { finish(false); });
	});
};

const receiveExternalRequest = async (connection, request) => {
	const self = await describeSelf();
	const here = (self.name || self.address);
	const address = clientAddress(connection);
	const name = (LABEL_PATTERN.test(String(request?.name || '')) ? request.name : address);
	if (!isNodeId(request?.id) || request.id === self.id || !net.isIPv4(address)) {
		return refuse('Pairing was refused.');
	}

	if (discovery.discover().some((node) => { return node.id === request.id || node.address === address; })) {
		return refuse(`${here} is on the same network as ${name}. Adopt it from the list of nodes instead.`);
	}

	if (await findPeer(request.id)) {
		return refuse(`${name} is already adopted by ${here}.`);
	}

	if (await findExternalPeer(request.id)) {
		return refuse(`${name} is already paired with ${here}.`);
	}

	if (!isSameVersion(request.version)) {
		return refuse(`${here} runs version ${self.version}, ${name} runs ${describeVersion(request.version)}. Update both to the same version first.`);
	}

	if ([...externalRequests.values()].some((entry) => { return entry.address === address; })) {
		return refuse(`A request from ${name} is already waiting on ${here}.`);
	}

	const now = Date.now();
	requestTimes.forEach((time, entry) => {
		if ((now - time) >= EXTERNAL_RETRY_MS) {
			requestTimes.delete(entry);
		}
	});
	if (requestTimes.has(address)) {
		return refuse(`${here} received a request from ${name} a moment ago. Try again in a minute.`);
	}

	requestTimes.set(address, now);
	if (!await canConnect(address, config.server.port) || !await canConnect(address, SSH_PORT)) {
		return refuse(`${here} can't reach ${name} at ${address}. The VPN must allow connections both ways.`);
	}

	if (connection.disconnected) {
		return refuse('Pairing was cancelled.');
	}

	if (externalRequests.size >= EXTERNAL_REQUEST_LIMIT) {
		return refuse(`${here} has too many requests waiting. Try again later.`);
	}

	const decision = await new Promise((resolve) => {
		const id = crypto.randomBytes(8).toString('hex');
		let timer = null;
		const settle = (value) => {
			if (!externalRequests.has(id)) {
				return false;
			}

			clearTimeout(timer);
			externalRequests.delete(id);
			publishRequests();
			resolve(value);
			return true;
		};
		timer = setTimeout(() => { settle({ result: 'expired' }); }, EXTERNAL_REQUEST_TTL_MS);
		externalRequests.set(id, { id, nodeId: request.id, name, address, version: self.version, connection, settle });
		connection.once('disconnect', () => { settle({ result: 'cancelled' }); });
		log.info(`External request from ${name} (${request.id}) at ${address} is waiting for an admin to answer.`);
		publishRequests();
	});

	if (decision.result === 'accept') {
		return { status: 'ok', node: self, key: decision.key };
	}

	if (decision.result === 'deny') {
		return refuse(`The admin of ${here} declined the request.`);
	}

	if (decision.result === 'block') {
		return refuse(`The admin of ${here} blocked this node.`);
	}

	if (decision.result === 'expired') {
		return refuse(`Nobody on ${here} answered the request in time.`);
	}

	return refuse('Pairing was cancelled.');
};

const attachNamespace = () => {
	const namespace = socket.getIO().of(NAMESPACE);
	namespace.use(async (connection, next) => {
		const { mode, nodeId } = connection.handshake.auth || {};
		// Adoption carries no credential — there is none yet — and can do exactly one thing: ask to be
		// adopted. Everything else needs the key that adoption hands out.
		if (mode === 'pair') {
			log.info(`Pairing connection from ${clientAddress(connection)}.`);
			connection.identity = { mode: 'pair' };
			next();
			return;
		}

		const peer = (mode === 'call' ? await findPeer(nodeId) : null);
		const externalPeer = (mode === 'call' && !peer ? await findExternalPeer(nodeId) : null);
		if (externalPeer) {
			connection.identity = { mode: 'call', peer: externalPeer, external: true };
			next();
			return;
		}

		if (!peer) {
			log.info(`Refused a connection from ${clientAddress(connection)}: ${(isNodeId(nodeId) ? `node ${nodeId}` : 'a node without a valid id')} is not adopted or paired here.`);
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
			connection.on('pair:request', async (request, reply) => {
				const source = clientAddress(connection);
				const requester = (LABEL_PATTERN.test(String(request?.name || '')) ? request.name : source);
				const acknowledge = (response) => {
					log.info(`Pairing request from ${describeRequest(request, source)}: ${(response.status === 'ok' ? 'paired' : response.message)}`);
					reply(response);
				};
				log.info(`Pairing request from ${describeRequest(request, source)}${(request?.adopt ? ', asking to adopt this node' : '')}.`);
				const self = await describeSelf();
				const offered = (request?.id < self.id && KEY_PATTERN.test(String(request.key || '')));
				if (!request?.id || request.id === self.id) {
					acknowledge({ status: 'failed', message: 'Pairing was refused.' });
					return;
				}

				if (await holdsVirtualIp()) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${self.name || self.address} holds the virtual IP, so it adopts other nodes and is never adopted by them.` });
					return;
				}

				if (!request.adopt) {
					acknowledge({ status: 'failed', message: 'Pairing was refused: only the node holding the virtual IP can pair nodes.' });
					return;
				}

				const advertised = discovery.discover().find((node) => { return node.id === request.id; });
				if (!advertised || ![advertised.address, (advertised.holdsVirtualIp ? advertised.virtualIp : null)].filter(Boolean).includes(source)) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${requester} is not on the network at ${source}.` });
					return;
				}

				if ((request.cluster || null) !== self.cluster) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${requester} is in ${request.cluster || 'no cluster'}, ${self.name || self.address} is in ${self.cluster || 'no cluster'}.` });
					return;
				}

				if (!isSameVersion(request.version)) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${requester} runs ${describeVersion(request.version)}, ${self.name || self.address} runs version ${self.version}.` });
					return;
				}

				if (request.adopt) {
					await dropStalePeers();
				}

				if (await findPeer(request.id)) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${requester} is already adopted by ${self.name || self.address}. Remove it first to pair again.` });
					return;
				}

				if (await findExternalPeer(request.id)) {
					acknowledge({ status: 'failed', message: `Pairing was refused: ${requester} is an external backup node of ${self.name || self.address}. Remove it first to adopt it.` });
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
			connection.on('pair:external', async (request, acknowledge) => {
				if (typeof acknowledge === 'function') {
					const source = clientAddress(connection);
					log.info(`External request from ${describeRequest(request, source)}.`);
					const response = await receiveExternalRequest(connection, request);
					log.info(`External request from ${describeRequest(request, source)}: ${(response.status === 'ok' ? 'accepted' : response.message)}`);
					acknowledge(response);
				}
			});
			return;
		}

		// A recognised id is not proof. Every call carries a token over this connection's nonce, so the
		// key authorises the action rather than merely knowing whose id to claim.
		const nonce = crypto.randomBytes(16).toString('hex');
		const handle = (event, handler) => {
			connection.on(event, async (request, acknowledge) => {
				if (connection.identity.external && !EXTERNAL_EVENTS.includes(event)) {
					log.warn(`Refused ${event} from external node ${connection.identity.peer.name || connection.identity.peer.address}: external nodes may not do that.`);
					acknowledge({ status: 'failed', message: 'Not authorised.' });
					return;
				}

				const payload = readCall(connection.identity.peer.key, nonce, event, request);
				if (!payload) {
					log.warn(`Refused ${event} from ${connection.identity.peer.name || connection.identity.peer.address}: the request could not be verified.`);
					acknowledge({ status: 'failed', message: 'Not authorised.' });
					return;
				}

				await observeClock(payload.clock);
				await handler(payload, (body) => {
					const signed = JSON.stringify(body);
					acknowledge({ payload: signed, signature: signReply(connection.identity.peer.key, payload.replyNonce, event, signed) });
				});
			});
		};
		handle('peer:remove', async (payload, respond) => {
			log.info(`peer:remove from ${connection.identity.peer.name || connection.identity.peer.address} (${connection.identity.peer.id}).`);
			if (connection.identity.external) {
				await forgetExternalPeer(connection.identity.peer.id);
			} else {
				await forgetPeer(connection.identity.peer.id);
			}

			respond({ status: 'ok' });
		});
		handle('peer:link', async (payload, respond) => {
			log.info(`peer:link from ${connection.identity.peer.name || connection.identity.peer.address} (${connection.identity.peer.id}).`);
			const self = await describeSelf();
			if (!payload?.node?.id || !payload?.node?.address || payload.node.id === self.id || !KEY_PATTERN.test(String(payload.key || ''))) {
				log.warn(`Refused peer:link from ${connection.identity.peer.name || connection.identity.peer.address}: nothing valid to pair with.`);
				respond({ status: 'failed', message: 'Nothing to pair with.' });
				return;
			}

			await savePeer({ id: payload.node.id, name: payload.node.name, address: payload.node.address, key: payload.key }, payload.clock);
			respond({ status: 'ok', clock: await loadClock() });
		});
		handle('peer:forget', async (payload, respond) => {
			log.info(`peer:forget from ${connection.identity.peer.name || connection.identity.peer.address} (${connection.identity.peer.id}).`);
			const self = await describeSelf();
			if (payload?.id && payload.id !== self.id && payload.id !== connection.identity.peer.id) {
				await removePeer(payload.id, payload.removedClock, [connection.identity.peer.id, ...(Array.isArray(payload.confirmedBy) ? payload.confirmedBy : [])]);
			}

			respond({ status: 'ok', clock: await loadClock() });
		});
		handle('peer:list', async (payload, respond) => {
			const peers = (await readConfiguration()).map((peer) => {
				return { id: peer.id, name: peer.name, address: peer.address, pairedClock: (Number(peer.pairedClock) || 0) };
			});
			const removed = (await readRemoved()).map((entry) => { return { id: entry.id, clock: (Number(entry.clock) || 0) }; });
			respond({ status: 'ok', peers, removed, clock: await loadClock() });
		});
		handle('replication:verify', async (payload, respond) => {
			log.info(`${connection.identity.peer.name || connection.identity.peer.address} asked this node to log in to it for backups.`);
			try {
				await hostModule?.getPlugin('replication')?.verify(connection.identity.peer.id);
				respond({ status: 'ok', clock: await loadClock() });
			} catch (error) {
				const self = await describeSelf();
				const peer = connection.identity.peer;
				log.warn(`Could not log in to ${peer.name || peer.address} for backups: ${String(error.stderr || error.shortMessage || error.message).trim()}`);
				respond({ status: 'failed', message: `${self.name || self.address} could not log in to ${peer.name || peer.address} at ${peer.address} to take backups. The VPN must allow connections both ways.` });
			}
		});
		handle('replication:exchange', async (payload, respond) => {
			log.info(`${connection.identity.peer.name || connection.identity.peer.address} sent its backup keys.`);
			const identity = await hostModule?.getPlugin('replication')?.exchange(connection.identity.peer.id, payload);
			respond(identity ? { status: 'ok', ...identity, clock: await loadClock() } : { status: 'failed', message: 'Could not prepare replication.' });
		});
		handle('virtualIp:configure', async (payload, respond) => {
			// Whether this is allowed is decided where the address lives, not here: a node holding it
			// refuses to be rewritten.
			hostModule?.eventEmitter.emit('host:peer:virtualIp:configure', payload.virtualIp);
			respond({ status: 'ok' });
		});
		handle('virtualIp:current', async (payload, respond) => {
			respond({ status: 'ok', virtualIp: await virtualIpConfiguration() });
		});
		handle('virtualIp:promote', async (payload, respond) => {
			try {
				await hostModule.addJob('host:network:virtualIp:promote', { username: connection.identity.peer.name || 'peer' });
				respond({ status: 'ok' });
			} catch (error) {
				respond({ status: 'failed', message: 'Could not take the virtual IP over.' });
			}
		});
		handle('virtualIp:release', async (payload, respond) => {
			// The only thing a peer may ask for, and only ever to let go — never to take. Recorded under
			// the asking node's name so the job history shows which node the migration came from; the
			// admin who started it is on that node.
			try {
				await hostModule.addJob('host:network:virtualIp:release', { username: connection.identity.peer.name || 'peer' });
				respond({ status: 'ok' });
			} catch (error) {
				respond({ status: 'failed', message: 'Could not release the virtual IP.' });
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
	const peer = (await findPeer(peerId) || await findExternalPeer(peerId));
	if (!peer) {
		const seen = (hostModule?.getState('discovery') || []).find((node) => { return node.id === peerId; });
		throw new Error(`${seen?.name || seen?.address || peerId} is not adopted.`);
	}

	const self = await describeSelf();
	const address = await resolveAddress(peer);
	if (!address) {
		throw new Error(`Could not reach ${peer.name || peer.address}.`);
	}

	const isRoutine = ROUTINE_EVENTS.includes(event);
	if (!isRoutine) {
		log.info(`Sending ${event} to ${peer.name || peer.address} at ${address}.`);
	}

	const connection = connectToPeer(address, { mode: 'call', nodeId: self.id });
	const sent = await loadClock();
	const replyNonce = crypto.randomBytes(16).toString('hex');
	try {
		const answer = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error(`${peer.name || peer.address} did not answer.`)); }, timeout);
			connection.on('connect_error', (error) => {
				clearTimeout(timer);
				reject(new Error(`Could not reach ${peer.name || peer.address}.`, { cause: error }));
			});
			connection.on('challenge', (nonce) => {
				const body = JSON.stringify({ ...payload, clock: sent, replyNonce });
				connection.emit(event, { payload: body, token: signCall(peer.key, nonce, event, body) }, (response) => {
					clearTimeout(timer);
					const verified = readReply(peer.key, replyNonce, event, response);
					if (!verified) {
						reject(new Error(`${peer.name || peer.address} sent an answer that could not be verified.`));
						return;
					}

					(verified.status === 'ok' ? resolve(verified) : reject(new Error(verified.message || `${peer.name || peer.address} refused.`)));
				});
			});
		});
		await observeClock(answer?.clock);
		if (!isRoutine) {
			log.info(`${event} to ${peer.name || peer.address} succeeded.`);
		}

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
			log.warn(`Could not tell ${peers[index].name || peers[index].address} about ${event}:`, result.reason);
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
	const seen = (hostModule?.getState('discovery') || []).find((node) => { return node.id === nodeId; });
	const connection = connectToPeer(address, { mode: 'pair' });
	log.info(`Asking ${seen?.name || address} (${nodeId}) at ${address} to pair${(adopting ? ' and be adopted' : '')}.`);
	try {
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error(`${seen?.name || address} did not answer.`)); }, (adopting ? REQUEST_TIMEOUT_MS + STALE_CHECK_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
			connection.on('connect_error', (error) => {
				clearTimeout(timer);
				reject(new Error(`Could not reach ${seen?.name || address}.`, { cause: error }));
			});
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

		if (!isSameVersion(response.node?.version)) {
			throw new Error(`${response.node?.name || address} runs ${(response.node?.version ? `version ${response.node.version}` : 'an older version')}, this node runs version ${self.version}.`);
		}

		const key = (response.key || offered);
		if (!KEY_PATTERN.test(String(key || ''))) {
			throw new Error('Pairing was refused.');
		}

		await savePeer({ id: response.node.id, name: response.node.name, address, key }, response.clock);
		if (response.virtualIp?.address) {
			hostModule?.eventEmitter.emit('host:peer:virtualIp:received', response.virtualIp);
		}

		log.info(`Paired with ${response.node.name || address} (${response.node.id}).`);
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

const holdsVirtualIp = async () => {
	const virtualIp = await virtualIpConfiguration();
	return Boolean(virtualIp?.address && await holdsAddress(virtualIp.address));
};

const link = async (first, second) => {
	log.info(`Linking ${first.name || first.address} with ${second.name || second.address}.`);
	const key = crypto.randomBytes(KEY_BYTES).toString('hex');
	await call(first.id, 'peer:link', { node: { id: second.id, name: second.name, address: second.address }, key });
	await call(second.id, 'peer:link', { node: { id: first.id, name: first.name, address: first.address }, key });
	log.info(`Linked ${first.name || first.address} with ${second.name || second.address}.`);
};

const introduce = async (nodeId) => {
	const newcomer = await findPeer(nodeId);
	const others = (await readConfiguration()).filter((peer) => { return peer.id !== nodeId; });
	const results = await Promise.allSettled(others.map((peer) => { return link(peer, newcomer); }));
	return others.filter((peer, index) => {
		if (results[index].status === 'fulfilled') {
			log.info(`Introduced ${newcomer.name || newcomer.address} to ${peer.name || peer.address}.`);
			return false;
		}

		log.warn(`Could not introduce ${newcomer.name || newcomer.address} to ${peer.name || peer.address}:`, results[index].reason);
		return true;
	}).map((peer) => { return peer.name || peer.address; });
};

const adopt = async (job, module) => {
	const { config } = job.data;
	const adopted = await findPeer(config.peerId);
	if (adopted) {
		throw new Error(`${adopted.name || adopted.address} is already adopted.`);
	}

	const external = await findExternalPeer(config.peerId);
	if (external) {
		throw new Error(`${external.name || external.address} is an external backup node. Remove it first to adopt it.`);
	}

	if (!await holdsVirtualIp()) {
		throw new Error('Only the node holding the virtual IP can adopt other nodes.');
	}

	const peer = discovery.discover().find((candidate) => { return candidate.id === config.peerId; });
	if (!peer) {
		throw new Error(`${config.peerId} is no longer on the network.`);
	}

	if (!peer.setupCompleted) {
		throw new Error(`${peer.name || peer.address} has not finished its own setup yet.`);
	}

	if (!isSameVersion(peer.version)) {
		throw new Error(`${peer.name || peer.address} runs ${(peer.version ? `version ${peer.version}` : 'an older version')}, this node runs version ${pkg.version}. Update both to the same version first.`);
	}

	const configured = await virtualIpConfiguration();
	if (peer.virtualIp && peer.virtualIp !== configured?.address) {
		throw new Error(`${peer.name || peer.address} has a different virtual IP (${peer.virtualIp}).`);
	}

	const { clusterDomain } = await getNodeIdentity();
	if ((peer.cluster || null) !== clusterDomain) {
		throw new Error(`${peer.name || peer.address} is in ${peer.cluster || 'no cluster'}, this node is in ${clusterDomain || 'no cluster'}. Set the same cluster on both first.`);
	}

	await reportProgress(job, module, `Adopting ${peer.name || peer.address}...`);
	const node = await pairOnce(peer.id, peer.address, true);
	await reportProgress(job, module, `Introducing ${node.name || peer.address} to the other nodes...`);
	const failed = await introduce(node.id);
	if (failed.length) {
		return `Adopted ${node.name || peer.address}. ${failed.join(', ')} could not be reached and will pair with it when they next see this node.`;
	}

	return `Adopted ${node.name || peer.address}.`;
};

const requestExternal = (address, self, onConnect) => {
	const connection = connectToPeer(address, { mode: 'pair' });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { reject(new Error(`${address} did not answer.`)); }, EXTERNAL_REQUEST_TTL_MS + REQUEST_TIMEOUT_MS);
		connection.on('connect_error', (error) => {
			clearTimeout(timer);
			reject(new Error(`Could not reach ${address}.`, { cause: error }));
		});
		connection.on('disconnect', (reason) => {
			clearTimeout(timer);
			reject(new Error(`${address} stopped answering.`, { cause: new Error(reason) }));
		});
		connection.on('connect', async () => {
			log.info(`Connected to ${address}, sending the external request.`);
			await onConnect();
			connection.emit('pair:external', { id: self.id, name: self.name, version: self.version }, (answer) => {
				clearTimeout(timer);
				(answer?.status === 'ok' ? resolve(answer) : reject(new Error(answer?.message || 'Pairing was refused.')));
			});
		});
	}).finally(() => {
		connection.close();
	});
};

const adoptExternal = async (job, module) => {
	const address = String(job.data.config?.address || '').trim();
	if (!net.isIPv4(address)) {
		throw new Error(`${address || 'The address'} is not an IP address.`);
	}

	if ((await ownAddresses()).includes(address)) {
		throw new Error(`${address} is this node.`);
	}

	const local = discovery.discover().find((node) => { return node.address === address || (node.holdsVirtualIp && node.virtualIp === address); });
	if (local) {
		throw new Error(`${local.name || address} is on this network. Adopt it from the list of nodes instead.`);
	}

	const paired = (await readExternalPeers()).find((peer) => { return peer.address === address; });
	if (paired) {
		throw new Error(`${paired.name || address} is already paired with this node.`);
	}

	const self = await describeSelf();
	log.info(`Asking ${address} to keep the backups of this node.`);
	await reportProgress(job, module, `Connecting to ${address}...`);
	const response = await requestExternal(address, self, () => { return reportProgress(job, module, `Waiting for ${address} to accept...`); });
	const node = (response.node || {});
	const name = (LABEL_PATTERN.test(String(node.name || '')) ? node.name : address);
	if (!isNodeId(node.id) || node.id === self.id || !KEY_PATTERN.test(String(response.key || ''))) {
		throw new Error(`${address} sent an answer that could not be used.`);
	}

	if (discovery.discover().some((entry) => { return entry.id === node.id; }) || await findPeer(node.id)) {
		throw new Error(`${name} is on this network. Adopt it from the list of nodes instead.`);
	}

	if (!isSameVersion(node.version)) {
		throw new Error(`${name} runs ${(node.version ? `version ${node.version}` : 'an older version')}, this node runs version ${pkg.version}. Update both to the same version first.`);
	}

	await saveExternalPeer({ id: node.id, name, address, key: response.key, role: 'recipient' });
	await reportProgress(job, module, `Setting up backups with ${name}...`);
	try {
		await module.getPlugin('replication').pair(node.id);
		log.info(`Exchanged backup keys with ${name}, asking it to log in to this node.`);
		await call(node.id, 'replication:verify', {}, REQUEST_TIMEOUT_MS * 2);
		log.info(`${name} logged in to this node for backups.`);
	} catch (error) {
		log.info(`Undoing the pairing with ${name}.`);
		try {
			await call(node.id, 'peer:remove');
		} catch (removeError) {
			log.warn(`Could not tell ${name} it was removed:`, removeError);
		}

		await forgetExternalPeer(node.id);
		throw new Error(`Could not set up backups with ${name}. ${error.message}`, { cause: error.cause });
	}

	return `Adopted ${name} as an external backup node.`;
};

const findRequest = (requestId) => {
	const request = externalRequests.get(String(requestId || ''));
	if (!request) {
		throw new Error('This request is no longer waiting.');
	}

	return request;
};

const acceptRequest = async (job, module) => {
	const request = findRequest(job.data.config?.requestId);
	await reportProgress(job, module, `Accepting ${request.name}...`);
	const key = crypto.randomBytes(KEY_BYTES).toString('hex');
	await saveExternalPeer({ id: request.nodeId, name: request.name, address: request.address, key, role: 'source' });
	if (!request.settle({ result: 'accept', key })) {
		await forgetExternalPeer(request.nodeId);
		throw new Error(`${request.name} stopped waiting for an answer.`);
	}

	return `Accepted ${request.name}. This node now keeps its backups.`;
};

const denyRequest = async (job, module) => {
	const request = findRequest(job.data.config?.requestId);
	request.settle({ result: 'deny' });
	return `Denied ${request.name}.`;
};

const blockRequest = async (job, module) => {
	const request = findRequest(job.data.config?.requestId);
	await reportProgress(job, module, `Blocking ${request.address}...`);
	request.settle({ result: 'block' });
	await waitForClose(request.connection);
	try {
		await execa('fail2ban-client', ['set', PAIRING_JAIL, 'banip', request.address]);
	} catch (error) {
		log.warn(`Could not block ${request.address}: ${error.shortMessage || error.message}`);
		throw new Error(`Could not block ${request.address}. ${request.name} was told it is blocked, but it can still ask again.`);
	}

	return `Blocked ${request.name} (${request.address}).`;
};

const stillAdopted = async (address, nodeId, timeout = REQUEST_TIMEOUT_MS) => {
	const connection = connectToPeer(address, { mode: 'call', nodeId });
	try {
		const isAdopted = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				log.info(`${address} did not answer whether it still has this node; keeping it.`);
				resolve(true);
			}, timeout);
			connection.on('connect', () => {
				clearTimeout(timer);
				resolve(true);
			});
			connection.on('connect_error', (error) => {
				clearTimeout(timer);
				if (error?.data?.reason !== 'unknown') {
					log.info(`Could not ask ${address} whether it still has this node (${error?.message || 'unknown error'}); keeping it.`);
				}

				resolve(error?.data?.reason !== 'unknown');
			});
		});
		return isAdopted;
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
			log.info(`${peers[index].peer.name || peers[index].peer.address} no longer has this node adopted; removing it.`);
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

	log.info(`${peer.name || peer.address} no longer has this node adopted; removing it.`);
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
		log.info(`Taking the virtual IP settings from ${peer.name || peer.address}: ${answer.virtualIp?.address || 'none'}.`);
		hostModule?.eventEmitter.emit('host:peer:virtualIp:configure', answer.virtualIp);
	} catch (error) {
		log.warn(`Could not read the virtual IP from ${peer.name || peer.address}:`, error);
	}
};

const reconcilePeers = async (peer) => {
	let answer = null;
	try {
		answer = await call(peer.id, 'peer:list');
	} catch (error) {
		log.warn(`Could not read the adopted nodes of ${peer.name || peer.address}:`, error);
		return;
	}

	for (const removal of (answer.removed || [])) {
		const known = await findPeer(removal.id);
		if (known && removal.id !== peer.id && (Number(removal.clock) || 0) > (Number(known.pairedClock) || 0)) {
			log.info(`${known.name || known.address} was removed while this node was away; forgetting it.`);
			await removePeer(removal.id, removal.clock, [peer.id]);
		}
	}

	const listed = (answer.peers || []).map((entry) => { return entry.id; });
	await confirmRemovals(peer.id, (await readRemoved()).map((entry) => { return entry.id; }).filter((id) => { return !listed.includes(id); }));

	if (!await holdsVirtualIp()) {
		return;
	}

	const visible = discovery.discover();
	for (const other of await readConfiguration()) {
		const node = visible.find((entry) => { return entry.id === other.id; });
		if (other.id === peer.id || listed.includes(other.id) || !node?.address || !node.setupCompleted) {
			continue;
		}

		log.info(`${other.name || node.address} was adopted while ${peer.name || peer.address} was away; pairing them.`);
		try {
			await link(peer, other);
		} catch (error) {
			log.warn(`Could not pair ${peer.name || peer.address} with ${other.name || node.address}:`, error);
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
			await reconcilePeers(peer);
		}
	}
};

const reconcileExternalPeers = async () => {
	const peers = await readExternalPeers();
	if (!peers.length) {
		return;
	}

	const self = await describeSelf();
	for (const peer of peers) {
		const pairedAt = Date.parse(peer.pairedAt);
		if (Number.isFinite(pairedAt) && (Date.now() - pairedAt) < ADOPTION_GRACE_MS) {
			continue;
		}

		if (!await stillAdopted(peer.address, self.id)) {
			log.info(`${peer.name || peer.address} no longer has this node paired; removing it.`);
			await forgetExternalPeer(peer.id);
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
		log.warn(`Could not reconcile adopted nodes:`, error);
	} finally {
		reconciling = false;
	}
};

/** One-sided by design: the node being removed is usually the one that has died. The virtual IP is
 * deliberately untouched — the address lives in the kernel, not in the pairing. */
const remove = async (job, module) => {
	const { config } = job.data;
	const external = await findExternalPeer(config.peerId);
	if (external) {
		await reportProgress(job, module, `Removing ${external.name || external.address}...`);
		try {
			await call(external.id, 'peer:remove');
		} catch (error) {
			log.warn(`Could not tell ${external.name || external.address} it was removed:`, error);
		}

		await forgetExternalPeer(external.id);
		return `${external.name || external.address} removed.`;
	}

	const peer = await findPeer(config.peerId);
	if (!peer) {
		const seen = (hostModule?.getState('discovery') || []).find((node) => { return node.id === config.peerId; });
		throw new Error(`${seen?.name || seen?.address || config.peerId} is not adopted.`);
	}

	await reportProgress(job, module, `Removing ${peer.name || peer.address}...`);
	// Best effort: a node that has died still has to be removable, so failing to reach it is not a
	// reason to leave it adopted here. When it does answer, both sides forget each other.
	try {
		await call(peer.id, 'peer:remove');
	} catch (error) {
		log.warn(`Could not tell ${peer.name || peer.address} it was removed:`, error);
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
			log.warn(`Could not tell ${others[index].name || others[index].address} that ${peer.name || peer.address} was removed:`, result.reason);
		}
	}

	if (told.length > 1) {
		const confirmations = await Promise.allSettled(told.map((id) => { return call(id, 'peer:forget', { id: peer.id, removedClock, confirmedBy: told }); }));
		confirmations.filter((result) => { return result.status === 'rejected'; }).forEach((result) => {
			log.warn(`Could not confirm the removal of ${peer.name || peer.address}:`, result.reason);
		});
	}

	return `${peer.name || peer.address} removed.`;
};

const logged = (run) => {
	return async (job, module) => {
		log.info(`${job.name} started by ${job.data?.username || 'unknown'} with ${JSON.stringify(job.data?.config || {})}.`);
		try {
			const result = await run(job, module);
			log.info(`${job.name} finished: ${result}`);
			return result;
		} catch (error) {
			log.warn(`${job.name} failed:`, error);
			throw error;
		}
	};
};

const onConnection = async (socket, module) => {
	// emitChanged suppresses a repeat of the last payload, so a browser connecting after the last
	// change would otherwise see nothing until the next adoption.
	if (socket.isAuthenticated && socket.isAdmin) {
		socket.emit('host:peers', withoutKeys(await readConfiguration()));
		socket.emit('host:peers:external', withoutKeys(await readExternalPeers()));
		socket.emit('host:peer:requests', module.getState('peerRequests') || []);
	}
};

const register = (module) => {
	hostModule = module;
	attachNamespace();
	publishPeers();
	publishExternalPeers();
	publishRequests();
	module.eventEmitter.on('host:discovery:updated', () => {
		scheduleReconcile();
	});
	module.eventEmitter.on('host:network:identifier:updated', () => {
		syncPeerRoutes();
	});
	module.eventEmitter.on('app:installed', ({ name } = {}) => {
		if (String(name || '').toLowerCase() === 'pihole') {
			syncPeerRoutes();
		}
	});
	setInterval(() => {
		reconciled.clear();
		scheduleReconcile();
		reconcileExternalPeers().catch((error) => {
			log.warn(`Could not reconcile external nodes:`, error);
		});
	}, RECONCILE_INTERVAL_MS);
};

export default {
	name: 'peer',
	register,
	onConnection,
	call,
	broadcast,
	findHolder,
	commands: {
		'host:peer:remove': { job: 'host:peer:remove' },
		'host:peer:adopt': { job: 'host:peer:adopt' },
		'host:peer:external:adopt': { job: 'host:peer:external:adopt', parallel: true },
		'host:peer:request:accept': { job: 'host:peer:request:accept', parallel: true },
		'host:peer:request:deny': { job: 'host:peer:request:deny', parallel: true },
		'host:peer:request:block': { job: 'host:peer:request:block', parallel: true }
	},
	jobs: {
		'host:peer:adopt': logged(adopt),
		'host:peer:remove': logged(remove),
		'host:peer:external:adopt': logged(adoptExternal),
		'host:peer:request:accept': logged(acceptRequest),
		'host:peer:request:deny': logged(denyRequest),
		'host:peer:request:block': logged(blockRequest)
	}
};
