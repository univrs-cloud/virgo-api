import { randomUUID } from 'crypto';
import si from 'systeminformation';
import { io } from 'socket.io-client';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import * as fleetProxy from '../../utils/fleet_proxy.js';
import * as webrtcProxy from '../../utils/webrtc_proxy.js';
import * as fleetState from '../../utils/fleet_state.js';
import * as email from '../../utils/email.js';
import * as network from '../../utils/network.js';
import * as virtualIp from '../host/virtual_ip.js';
import { getNodeId } from '../host/advertisement.js';

const fleetUrl = config.fleet.url;
const AUTH_FAILED_ERROR = 'Node authentication failed';
// A mass power event brings many nodes back at once; without a spread they'd all open their
// control socket in the same tick and hammer the fleet server (each connect is a serialised
// SQLite write). Delay the boot-time auto-connect by a random offset in this window so the
// reconnect load arrives smeared across time instead of as a single spike.
const STARTUP_JITTER_MS = 30000;
const ACME_RELAY_TIMEOUT_MS = 10000;
const ACME_CONNECT_TIMEOUT_MS = 15000;
const ACME_CONNECT_POLL_MS = 500;
const DOMAIN_REPORT_DELAY_MS = 3000;
let fleetSocket = null;
let domainReportTimer = null;
let fleetModule = null;
// Each matches its source event: system is host:updates, apps is the docker module's per-app update
// summary (array | [] | false).
let lastSystemUpdates = false;
let lastAppUpdates = false;
let lastUpdate = null;
let lastUpdateSignature = null;
let lastStorage = false;
let lastUps = null;
let lastPeers = [];

const reportUpdatesToFleet = () => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:updates', { system: lastSystemUpdates, apps: lastAppUpdates });
	}
};

/** An app update in flight, forwarded as the same job this node's own UI receives so the fleet can
 * follow it the way the apps page does. */
const reportAppUpdateJobToFleet = (job) => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:app:update:job', job);
	}
};

/** The fleet drops everything it knew about a node when the socket goes, so a fresh connection has to
 * replay whatever app updates are already running. */
const requestAppUpdateJobs = () => {
	fleetModule?.eventEmitter?.emit('app:update:jobs:sync');
};

const reportStorageToFleet = () => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:storage', lastStorage);
	}
};

const reportUpsToFleet = () => {
	if (fleetSocket?.connected) {
		fleetSocket.emit('node:ups', lastUps);
	}
};

const reportPeersToFleet = async () => {
	if (!fleetSocket?.connected) {
		return;
	}

	fleetSocket.emit('node:peers', { selfId: await getNodeId(), peers: lastPeers });
};

const reportDomainToFleet = async () => {
	if (!fleetSocket?.connected) {
		return;
	}

	const identifier = await getNodeIdentifier();
	if (!identifier.hostname || !identifier.domainName || !identifier.address) {
		return;
	}

	fleetSocket.emit('node:domain:claim', identifier, (response) => {
		if (response?.status !== 'succeeded') {
			console.error(`Fleet domain claim failed: ${response?.message || 'no response'}`);
		}
	});
};

const scheduleDomainReport = () => {
	clearTimeout(domainReportTimer);
	domainReportTimer = setTimeout(() => {
		domainReportTimer = null;
		reportDomainToFleet().catch((error) => {
			console.error('Error reporting the node address to fleet:', error);
		});
	}, DOMAIN_REPORT_DELAY_MS);
	domainReportTimer.unref();
};

const fleetUpdate = () => {
	const state = lastUpdate?.state;
	if (state === 'running') {
		return { state, progress: lastUpdate.progress ?? null };
	}

	if (state === 'succeeded' || state === 'failed') {
		return { state };
	}
	
	return null;
};

const updateSignature = (update) => {
	if (!update) {
		return null;
	}

	return (update.state === 'running' ? `running:${update.progress?.stage ?? ''}:${update.progress?.percent ?? ''}` : update.state);
};

const reportUpdateToFleet = () => {
	if (!fleetSocket?.connected) {
		return;
	}

	const update = fleetUpdate();
	lastUpdateSignature = updateSignature(update);
	fleetSocket.emit('node:update', update);
};

const randomStartupDelay = () => {
	return Math.floor(Math.random() * STARTUP_JITTER_MS);
};

const broadcastConfigurationUpdate = () => {
	fleetModule?.eventEmitter?.emit('configuration:updated');
};

const getNodeName = async () => {
	const osInfo = await si.osInfo();
	return osInfo?.hostname || osInfo?.fqdn || null;
};

const getNodeIdentifier = async () => {
	const osInfo = await si.osInfo();
	const hostname = osInfo?.hostname || '';
	const fqdn = osInfo?.fqdn || '';
	const prefix = `${hostname}.`;
	return {
		hostname,
		domainName: (hostname && fqdn.startsWith(prefix) ? fqdn.slice(prefix.length) : ''),
		address: await getNodeAddress()
	};
};

/** The virtual IP wins when this node is the one holding it: it is the address the router forwards to
 * and the one that survives a node being replaced, so it is what the fleet's LAN records should point
 * at. A node that has it configured but stood down answers on its own address instead. */
const getNodeAddress = async () => {
	try {
		const configured = await virtualIp.readConfiguration();
		if (configured?.address && await virtualIp.isEnabled()) {
			return configured.address;
		}

		const device = await network.getDefaultInterfaceName();
		const addrInfo = (await network.getAddresses()).find((item) => { return item.ifname === device; })?.addr_info || [];
		const address = addrInfo.find((info) => { return info.family === 'inet' && info.local !== virtualIp?.address; });
		return address?.local || '';
	} catch (error) {
		return '';
	}
};

const refreshWebrtcBindAddress = async () => {
	try {
		const configured = await virtualIp.readConfiguration();
		webrtcProxy.setBindAddress(await network.getOwnAddress(configured?.address || null));
	} catch (error) {
		webrtcProxy.setBindAddress(null);
	}
};

/** This node's fleet identity: minted on first registration and kept for as long as the node stays
 * enrolled, so a retry after a failed attempt — or a later re-registration — lands on the same fleet
 * record instead of creating a second one. Persisted before registering for exactly that reason: if
 * the fleet commits the record but the node never sees the answer, the retry reuses this id and
 * recovers onto that record rather than stranding it. A node is registered once it holds a token, so
 * writing the id alone does not present it as enrolled. Unregistering clears the whole record,
 * identity included, so the next registration mints a fresh one. */
const resolveNodeId = async (configuration) => {
	const existing = configuration?.fleet?.nodeId || '';
	if (existing) {
		return existing;
	}

	const nodeId = randomUUID();
	await DataService.setConfiguration('fleet', { ...configuration?.fleet, nodeId });
	return nodeId;
};

const connect = async ({ token, nodeId }) => {
	disconnect();
	fleetState.resetRuntimeState();
	fleetSocket = io(`${fleetUrl}/node`, {
		path: '/api',
		auth: { role: 'node', secret: token },
		rejectUnauthorized: true,
		reconnection: true,
		reconnectionDelay: 2000,
		reconnectionDelayMax: 10000,
		// Spread reconnection attempts: when the fleet server restarts, every node drops and
		// retries at once, so widen the backoff randomisation to de-correlate the retry storm.
		randomizationFactor: 0.75
	});
	fleetSocket.on('connect', () => {
		fleetState.setRuntimeState({ connected: true, authFailed: false });
		fleetProxy.attachHandlers(fleetSocket);
		refreshWebrtcBindAddress();
		webrtcProxy.attachWebrtcHandlers(fleetSocket, { token, nodeId });
		fleetSocket.emit('node:capabilities', { webrtc: webrtcProxy.isSupported() });
		broadcastConfigurationUpdate();
		reportUpdatesToFleet();
		reportUpdateToFleet();
		reportStorageToFleet();
		reportUpsToFleet();
		reportPeersToFleet().catch((error) => {
			console.error('Error reporting peers to fleet:', error);
		});
		requestAppUpdateJobs();
		scheduleDomainReport();
	});
	fleetSocket.on('fleet:unregister', async (ack = () => {}) => {
		try {
			await DataService.deleteConfiguration('fleet');
			broadcastConfigurationUpdate();
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		} finally {
			disconnect();
		}
	});
	fleetSocket.on('disconnect', () => {
		fleetState.setRuntimeState({ connected: false });
		broadcastConfigurationUpdate();
	});
	fleetSocket.on('connect_error', (error) => {
		console.error('Fleet connection error:', error?.message || error);
		if (error?.message === AUTH_FAILED_ERROR) {
			fleetState.setRuntimeState({ connected: false, authFailed: true });
			fleetSocket?.disconnect();
			fleetSocket = null;
			broadcastConfigurationUpdate();
		}
	});
};

const disconnect = () => {
	webrtcProxy.closeAllSessions();
	if (fleetSocket) {
		fleetSocket.disconnect();
		fleetSocket = null;
	}
	fleetState.resetRuntimeState();
};

const registerNode = ({ email, password, nodeId, name, hostname, domainName, address }) => {
	return new Promise((resolve, reject) => {
		const socket = io(`${fleetUrl}/node`, {
			path: '/api',
			auth: { role: 'node' },
			rejectUnauthorized: true,
			reconnection: false,
			timeout: 10000
		});
		socket.on('connect_error', (error) => {
			socket.disconnect();
			reject(new Error(error?.message || 'Failed to connect to fleet'));
		});
		socket.on('connect', () => {
			socket.emit('node:register', { nodeId, name, hostname, domainName, address, email, password }, (response) => {
				socket.disconnect();
				if (response?.status !== 'succeeded') {
					reject(new Error(response?.message || 'Fleet registration failed'));
					return;
				}
				resolve({ nodeId: response.nodeId, token: response.token });
			});
		});
	});
};

const checkDomainAvailability = (label) => {
	return new Promise((resolve, reject) => {
		const socket = io(`${fleetUrl}/node`, {
			path: '/api',
			auth: { role: 'node' },
			rejectUnauthorized: true,
			reconnection: false,
			timeout: 10000
		});
		socket.on('connect_error', (error) => {
			socket.disconnect();
			reject(new Error(error?.message || 'Failed to connect to fleet'));
		});
		socket.on('connect', () => {
			socket.emit('node:domain:availability', { label }, (response) => {
				socket.disconnect();
				if (response?.status !== 'succeeded') {
					reject(new Error(response?.message || 'Fleet availability check failed'));
					return;
				}
				resolve({ available: response.available, reason: response.reason, zone: response.zone });
			});
		});
	});
};

const registerFleet = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, 'Registering with fleet...');

	const configuration = await DataService.getConfiguration();
	const submittedEmail = email.normalize(config?.email);
	const registeredEmail = email.normalize(configuration?.fleet?.token ? configuration?.fleet?.email : '');
	if (registeredEmail && registeredEmail !== submittedEmail) {
		throw new Error('Fleet email cannot be changed');
	}

	const email = registeredEmail || submittedEmail;
	const { nodeId, token } = await registerNode({
		email,
		password: config.password,
		nodeId: await resolveNodeId(configuration),
		name: await getNodeName(),
		...await getNodeIdentifier()
	});

	await DataService.setConfiguration('fleet', { enabled: true, nodeId, token, email });
	module.eventEmitter.emit('configuration:updated');
	await connect({ token, nodeId });
	return 'Fleet registered.';
};

const enableFleet = async (job, module) => {
	await module.updateJobProgress(job, 'Enabling fleet...');
	const configuration = await DataService.getConfiguration();
	const fleet = configuration?.fleet;
	if (!fleet?.token) {
		throw new Error('Fleet is not registered');
	}
	
	await DataService.setConfiguration('fleet', { ...fleet, enabled: true });
	module.eventEmitter.emit('configuration:updated');
	await connect({ token: fleet.token, nodeId: fleet.nodeId });
	return 'Fleet enabled.';
};

const disableFleet = async (job, module) => {
	await module.updateJobProgress(job, 'Disabling fleet...');
	const configuration = await DataService.getConfiguration();
	const fleet = configuration?.fleet;
	if (!fleet?.token) {
		throw new Error('Fleet is not registered');
	}

	await DataService.setConfiguration('fleet', { ...fleet, enabled: false });
	module.eventEmitter.emit('configuration:updated');
	disconnect();
	return 'Fleet disabled.';
};

const startIfEnabled = async () => {
	try {
		const configuration = await DataService.getConfiguration();
		const fleet = configuration?.fleet;
		if (fleet?.enabled && fleet?.token) {
			// Jitter only the boot-time auto-connect; user-initiated register/enable stay immediate.
			const delay = randomStartupDelay();
			setTimeout(() => {
				// A registration during the wait already opened the socket; leave it alone.
				if (fleetSocket) {
					return;
				}

				connect({ token: fleet.token, nodeId: fleet.nodeId })
					.catch((error) => {
						console.error('Error starting fleet connection:', error);
					});
			}, delay);
		}
	} catch (error) {
		console.error('Error starting fleet connection:', error);
	}
};

const register = (module) => {
	fleetModule = module;
	module.eventEmitter.on('host:updates:updated', (updates) => {
		lastSystemUpdates = updates;
		reportUpdatesToFleet();
	});
	module.eventEmitter.on('app:updates:updated', (updates) => {
		lastAppUpdates = updates;
		reportUpdatesToFleet();
	});
	module.eventEmitter.on('app:update:job:updated', reportAppUpdateJobToFleet);
	module.eventEmitter.on('host:update:updated', (update) => {
		lastUpdate = update;
		if (updateSignature(fleetUpdate()) === lastUpdateSignature) {
			return;
		}

		reportUpdateToFleet();
	});
	module.eventEmitter.on('host:storage:updated', (storage) => {
		lastStorage = storage;
		reportStorageToFleet();
	});
	module.eventEmitter.on('host:ups:updated', (ups) => {
		lastUps = ups;
		reportUpsToFleet();
	});
	module.eventEmitter.on('host:peers:updated', (peers) => {
		lastPeers = peers;
		reportPeersToFleet().catch((error) => {
			console.error('Error reporting peers to fleet:', error);
		});
	});
	module.eventEmitter.on('host:network:identifier:updated', scheduleDomainReport);
	module.eventEmitter.on('host:network:interface:updated', scheduleDomainReport);
	module.eventEmitter.on('host:network:virtualIp:updated', scheduleDomainReport);
	module.eventEmitter.on('host:network:interface:updated', refreshWebrtcBindAddress);
	module.eventEmitter.on('host:network:virtualIp:updated', refreshWebrtcBindAddress);
	// A node that boots before its pool reads no configuration at all, so an enrolment carried by a
	// pool imported afterwards is only discovered when the configuration becomes readable.
	module.eventEmitter.on('configuration:updated', startIfEnabled);
	startIfEnabled();
};

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:register', { config, username: socket.username });
	});

	socket.on('configuration:fleet:enable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:enable', { username: socket.username });
	});

	socket.on('configuration:fleet:domain:availability', async ({ label } = {}, ack = () => {}) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			ack({ status: 'failed', message: 'Unauthorized' });
			return;
		}

		try {
			ack({ status: 'succeeded', ...await checkDomainAvailability(label) });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('configuration:fleet:disable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		await module.addJob('fleet:disable', { username: socket.username });
	});
};

const waitForFleet = async () => {
	const deadline = Date.now() + ACME_CONNECT_TIMEOUT_MS;
	while (!fleetSocket?.connected && Date.now() < deadline) {
		await new Promise((resolve) => { setTimeout(resolve, ACME_CONNECT_POLL_MS); });
	}

	return Boolean(fleetSocket?.connected);
};

export const relayAcmeChallenge = async (action, { fqdn, value }) => {
	if (!await waitForFleet()) {
		throw new Error('Not connected to fleet');
	}

	console.log(`[acme] relaying ${action} for ${fqdn} to fleet`);

	const response = await fleetSocket.timeout(ACME_RELAY_TIMEOUT_MS).emitWithAck(`acme:${action}`, { fqdn, value });
	if (response?.status !== 'succeeded') {
		throw new Error(response?.message || `Fleet rejected the ACME ${action}`);
	}

	return response;
};

export default {
	name: 'fleet',
	register,
	onConnection,
	jobs: {
		'fleet:register': registerFleet,
		'fleet:enable': enableFleet,
		'fleet:disable': disableFleet
	}
};
