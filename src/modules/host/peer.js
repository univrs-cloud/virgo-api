import crypto from 'crypto';
import https from 'https';
import { io as ioClient } from 'socket.io-client';
import pkg from '../../../package.json' with { type: 'json' };
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as socket from '../../socket.js';
import * as advertisement from './advertisement.js';
import * as discovery from './discovery.js';
import { getOwnAddress } from '../../utils/network.js';

const { version } = pkg;
const NAMESPACE = '/peer';
const KEY_BYTES = 32;
const REQUEST_TIMEOUT_MS = 15000;

let hostModule = null;
const reconciled = new Set();

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
		address: await getOwnAddress(virtualIp?.address),
		version
	};
};

/** Discovery knows where a peer is right now; the stored address is only where it was when adopted. */
const resolveAddress = (peer) => {
	return (discovery.discover().find((node) => { return node.id === peer.id; })?.address || peer.address);
};

const publishPeers = async () => {
	const peers = await readConfiguration();
	hostModule?.setState('peers', peers);
	hostModule?.emitChanged('host:peers', peers, {
		filter: (connection) => { return connection.isAuthenticated && connection.isAdmin; }
	});
};

const forgetPeer = async (nodeId) => {
	const peers = await readConfiguration();
	await DataService.setConfiguration('peers', peers.filter((entry) => { return entry.id !== nodeId; }));
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
};

/** Adopting one node does not preclude adopting another, so this appends rather than replaces. A node
 * already on the list is refreshed in place — re-adopting is how a peer that was rebuilt gets a new
 * key without first being removed. */
const savePeer = async ({ id, name, address, key }) => {
	const peers = await readConfiguration();
	const peer = { id, name, address, key, pairedAt: new Date().toISOString() };
	await DataService.setConfiguration('peers', [...peers.filter((entry) => { return entry.id !== id; }), peer]);
	await publishPeers();
	hostModule?.eventEmitter.emit('host:peer:updated');
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
				const key = crypto.randomBytes(KEY_BYTES).toString('hex');
				await savePeer({ id: request.id, name: request.name, address: request.address, key });
				if (request.virtualIp?.address) {
					hostModule?.eventEmitter.emit('host:peer:virtualIp:received', request.virtualIp);
				}

				// The virtual IP travels with the adoption. Without it the adopting node has no address
				// of its own to take over later — it can see this one holds an address, but not which
				// address it would be claiming or on what prefix.
				acknowledge({ status: 'ok', node: await describeSelf(), key, virtualIp: await virtualIpConfiguration() });
			});
			return;
		}

		// A recognised id is not proof. Every call carries a token over this connection's nonce, so the
		// key authorises the action rather than merely knowing whose id to claim.
		const nonce = crypto.randomBytes(16).toString('hex');
		connection.on('peer:remove', async (payload, acknowledge) => {
			if (!matches(payload?.token, sign(connection.identity.peer.key, nonce))) {
				acknowledge({ status: 'failed', message: 'Not authorised.' });
				return;
			}

			await forgetPeer(connection.identity.peer.id);
			acknowledge({ status: 'ok' });
		});
		connection.on('virtualIp:promote', async (payload, acknowledge) => {
			if (!matches(payload?.token, sign(connection.identity.peer.key, nonce))) {
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
			if (!matches(payload?.token, sign(connection.identity.peer.key, nonce))) {
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
const call = async (peerId, event, payload = {}) => {
	const peer = await findPeer(peerId);
	if (!peer) {
		throw new Error(`That node is not adopted.`);
	}

	const self = await describeSelf();
	const connection = connectToPeer(resolveAddress(peer), { mode: 'call', nodeId: self.id });
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error(`${peer.name || peer.address} did not answer.`)); }, REQUEST_TIMEOUT_MS);
			connection.on('connect_error', () => { clearTimeout(timer); reject(new Error(`Could not reach ${peer.name || peer.address}.`)); });
			connection.on('challenge', (nonce) => {
				connection.emit(event, { token: sign(peer.key, nonce), ...payload }, (answer) => {
					clearTimeout(timer);
					(answer?.status === 'ok' ? resolve(answer) : reject(new Error(answer?.message || `${peer.name || peer.address} refused.`)));
				});
			});
		});
	} finally {
		connection.close();
	}
};

/** One call: the other node mints a key, keeps it, and hands back a copy. */
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
	const self = await describeSelf();
	// Sent as well as read back: the node holding the address is the one that adopts, so the config
	// usually travels outward. Both directions are carried so it works whichever side initiates.
	const configured = await virtualIpConfiguration();
	const connection = connectToPeer(peer.address, { mode: 'pair' });
	try {
		const response = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { reject(new Error('That node did not answer.')); }, REQUEST_TIMEOUT_MS);
			connection.on('connect_error', () => { clearTimeout(timer); reject(new Error('Could not reach that node.')); });
			connection.on('connect', () => {
				connection.emit('pair:request', { ...self, virtualIp: configured }, (answer) => {
					clearTimeout(timer);
					(answer?.status === 'ok' ? resolve(answer) : reject(new Error(answer?.message || 'Pairing was refused.')));
				});
			});
		});
		await savePeer({ id: response.node.id, name: response.node.name, address: peer.address, key: response.key });
		if (response.virtualIp?.address) {
			module.eventEmitter.emit('host:peer:virtualIp:received', response.virtualIp);
		}

		return `Adopted ${response.node.name || peer.address}.`;
	} finally {
		connection.close();
	}
};

/** Removal only ever reaches a node that is up. Remove a node while it is powered off and it comes
 * back still believing it is adopted, holding a key the other side has already forgotten — so the one
 * left behind has to notice for itself.
 *
 * Being told "I do not know you" is the only answer that removes anything. Unreachable, timed out and
 * refused all leave the pairing alone: not hearing back is not the same as having been removed, and
 * treating it that way would drop a peer every time the other node reboots. */
const reconcile = async (peer) => {
	const self = await describeSelf();
	const connection = connectToPeer(resolveAddress(peer), { mode: 'call', nodeId: self.id });
	try {
		const adopted = await new Promise((resolve) => {
			const timer = setTimeout(() => { resolve(true); }, REQUEST_TIMEOUT_MS);
			connection.on('connect', () => { clearTimeout(timer); resolve(true); });
			connection.on('connect_error', (error) => { clearTimeout(timer); resolve(error?.data?.reason !== 'unknown'); });
		});
		if (adopted) {
			return;
		}

		console.log(`${peer.name || peer.address} no longer has this node adopted; removing it.`);
		await forgetPeer(peer.id);
	} finally {
		connection.close();
	}
};

/** Checked when a peer turns up on the network, which covers both sides of the case: this node
 * booting and seeing its peers, and a peer booting and being seen. Once per appearance — a peer that
 * stays visible is not re-checked, and going away is what arms the next check. */
const reconcileVisible = async (nodes) => {
	const visible = new Set(nodes.map((node) => { return node.id; }));
	reconciled.forEach((id) => {
		if (!visible.has(id)) {
			reconciled.delete(id);
		}
	});

	for (const peer of await readConfiguration()) {
		if (!visible.has(peer.id) || reconciled.has(peer.id)) {
			continue;
		}

		reconciled.add(peer.id);
		await reconcile(peer);
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

	await forgetPeer(peer.id);
	return `${peer.name || peer.address} removed.`;
};

const onConnection = (socket, module) => {
	// emitChanged suppresses a repeat of the last payload, so a browser connecting after the last
	// change would otherwise see nothing until the next adoption.
	if (socket.isAuthenticated && socket.isAdmin) {
		readConfiguration().then((peers) => { socket.emit('host:peers', peers); });
	}

	socket.on('host:peer:adopt', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:peer:adopt', { config, username: socket.username });
	});
	socket.on('host:peer:remove', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:peer:remove', { config, username: socket.username });
	});
};

const register = (module) => {
	hostModule = module;
	attachNamespace();
	publishPeers();
	module.eventEmitter.on('host:discovery:updated', (nodes) => {
		reconcileVisible(nodes).catch((error) => {
			console.warn(`Could not reconcile adopted nodes: ${error.message}`);
		});
	});
};

export default {
	name: 'peer',
	register,
	onConnection,
	jobs: {
		'host:peer:adopt': adopt,
		'host:peer:remove': remove
	}
};

export { call, findHolder };
