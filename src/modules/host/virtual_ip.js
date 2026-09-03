import fs from 'fs/promises';
import { execa } from 'execa';
import DataService from '../../database/data_service.js';
import { BOND_NAME, getDefaultInterfaceName, isAddressInUse, holdsAddress } from '../../utils/network.js';
import * as discovery from './discovery.js';
import * as peer from './peer.js';

const ENVIRONMENT_FILE = '/etc/default/virgo-virtual-ip';
const UNIT = 'virgo-virtual-ip.service';
const HANDOVER_TIMEOUT_MS = 15000;
const HANDOVER_INTERVAL_MS = 500;

const toInteger = (address) => {
	return address.split('.').reduce((total, octet) => { return ((total << 8) >>> 0) + Number(octet); }, 0) >>> 0;
};

const isIPv4 = (address) => {
	const octets = String(address || '').split('.');
	return octets.length === 4 && octets.every((octet) => {
		return /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
	});
};

const isSameSubnet = (first, second, prefixLength) => {
	const mask = (prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0);
	return ((toInteger(first) & mask) >>> 0) === ((toInteger(second) & mask) >>> 0);
};

const readConfiguration = async () => {
	return (await DataService.getConfiguration()).virtualIp || null;
};

const isEnabled = async () => {
	try {
		const { stdout } = await execa('systemctl', ['is-enabled', UNIT]);
		return stdout.trim() === 'enabled';
	} catch (error) {
		return false;
	}
};

const writeEnvironmentFile = async ({ address, netmask, device }) => {
	const contents = `VIRTUAL_IP_ADDR=${address}\nVIRTUAL_IP_CIDR=${address}/${netmask}\nVIRTUAL_IP_DEV=${device}\n`;
	await fs.writeFile(ENVIRONMENT_FILE, contents, 'utf8');
};

/** The virtual IP must never move on its own, so claiming is the only operation that probes: if
 * another host already answers, this node stands down rather than creating a duplicate address. */
const claim = async (address) => {
	if (!await holdsAddress(address) && await isAddressInUse(address) === true) {
		throw new Error(`${address} is already held by another host on the network.`);
	}

	await execa('systemctl', ['enable', '--now', UNIT]);
};

const standDown = async () => {
	await execa('systemctl', ['disable', '--now', UNIT]);
};

/** Validated against the interface configuration being submitted, not against what the node currently
 * holds: the two are written in one job, and the virtual IP has to make sense on the addressing the
 * node is moving to. */
const validate = (virtualIp, config) => {
	if (!isIPv4(virtualIp)) {
		throw new Error(`${virtualIp} is not a valid IPv4 address.`);
	}

	if (config.method !== 'manual') {
		throw new Error(`A virtual IP needs a static address; it cannot be used with automatic addressing.`);
	}

	if (virtualIp === config.ipAddress) {
		throw new Error(`The virtual IP cannot be the same as the node's own address.`);
	}

	const prefixLength = Number.parseInt(config.netmask, 10);
	if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) {
		throw new Error(`${config.netmask} is not a valid netmask.`);
	}

	if (!isIPv4(config.ipAddress)) {
		throw new Error(`${config.ipAddress} is not a valid IPv4 address.`);
	}

	if (!isSameSubnet(virtualIp, config.ipAddress, prefixLength)) {
		throw new Error(`${virtualIp} is not in the same subnet as ${config.ipAddress}/${prefixLength}.`);
	}
};

/** A node that has no virtual IP of its own may not claim one while another node on the segment
 * already carries one — those two should be paired instead, and two unrelated holders is the state
 * the design exists to avoid. A node that already has one may keep changing it.
 *
 * Enforced here rather than only in the form: a disabled input is not a permission check, and the CLI
 * reaches this same job. Discovery failing answers nothing, so it fails open with a warning and
 * leaves the ARP probe in `claim()` as the check that can still prove a collision. */
/** Holding the address is what earns the right to change it — not merely having it configured. A
 * standby has the address in its configuration precisely so it can take over later, so treating that
 * as ownership would let the node that must not touch the address be the one allowed to. */
const assertClaimable = async () => {
	const configured = await readConfiguration();
	if (configured?.address && await holdsAddress(configured.address)) {
		return;
	}

	let peers = [];
	try {
		peers = await discovery.discover();
	} catch (error) {
		console.warn(`Could not check the network for other virtual IPs: ${error.shortMessage || error.message}`);
		return;
	}

	const holder = peers.find((peer) => { return Boolean(peer.virtualIp); });
	if (holder) {
		throw new Error(`${holder.name || holder.address} already has virtual IP ${holder.virtualIp}. Join that node instead of configuring a second one.`);
	}
};

/** A node that shares an address with another has to sit in the same subnet as it, or it could never
 * answer for it. Enforced here as well as in the form because the CLI reaches the same job, and
 * because discovery may have moved on since the form was filled in. */
const validateAgainstPeers = (config) => {
	const holder = discovery.discover().find((node) => { return Boolean(node.virtualIp); });
	if (!holder) {
		return;
	}

	const prefixLength = Number.parseInt(config.netmask, 10);
	if (!isSameSubnet(config.ipAddress, holder.virtualIp, prefixLength)) {
		throw new Error(`${config.ipAddress}/${prefixLength} is not in the same subnet as ${holder.virtualIp}, the virtual IP on ${holder.name || holder.address}.`);
	}
};

/** Applied after the bond is up, because bringing the connection up flushes the interface's
 * addresses. An empty value removes the virtual IP rather than leaving a stale one behind. */
/** `undefined` means the submission did not carry a virtual IP and this leaves it alone; an empty
 * value means the operator cleared it. The two are not the same, and conflating them made every
 * interface edit that omitted the field — a DNS change from the CLI, a locked field in the modal —
 * silently drop the address. */
const apply = async (virtualIp, config, module) => {
	if (virtualIp === undefined) {
		return;
	}

	const device = await getDefaultInterfaceName() || BOND_NAME;
	if (!virtualIp) {
		if (await readConfiguration()) {
			await standDown();
			await DataService.setConfiguration('virtualIp', null);
			module.eventEmitter.emit('host:network:virtualIp:updated');
		}

		return;
	}

	validate(virtualIp, config);
	await assertClaimable();
	await writeEnvironmentFile({ address: virtualIp, netmask: config.netmask, device });
	await DataService.setConfiguration('virtualIp', { address: virtualIp, netmask: config.netmask, device });
	await claim(virtualIp);
	module.eventEmitter.emit('host:network:virtualIp:updated');
};

/** Taking the address over means the node holding it has to let go first, and only an adopted node can
 * be asked to. That is what the key exchanged at adoption authorises. A holder that was never adopted
 * cannot be asked, so the ARP probe in `claim()` refuses rather than creating a duplicate address. */
const waitForRelease = async (address) => {
	const deadline = Date.now() + HANDOVER_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isAddressInUse(address) !== true) {
			return true;
		}

		await new Promise((resolve) => { setTimeout(resolve, HANDOVER_INTERVAL_MS); });
	}

	return false;
};

/** Written but never claimed: the unit is left disabled, so taking the address over stays a deliberate
 * act. Clearing removes the configuration without touching the address, which this node does not hold. */
const storeConfiguration = async (received, module) => {
	const device = await getDefaultInterfaceName() || BOND_NAME;
	const configuration = (received?.address ? { address: received.address, netmask: received.netmask, device } : null);
	try {
		if (configuration) {
			await writeEnvironmentFile(configuration);
		}

		await DataService.setConfiguration('virtualIp', configuration);
		module.eventEmitter.emit('host:network:virtualIp:updated');
	} catch (error) {
		console.warn(`Could not store the virtual IP from the other node: ${error.shortMessage || error.message}`);
	}
};

/** Adoption tells this node which address the pair shares. It never overwrites, because a node that
 * already has one is either the holder or a standby that was told by the holder. */
const adoptConfiguration = async (received, module) => {
	if (await readConfiguration()) {
		return;
	}

	await storeConfiguration(received, module);
};

/** The holder changed the address, so a standby has to follow or it keeps a configuration for an
 * address nobody has — which reads in the UI as a node that simply cannot take over, with nothing said.
 *
 * Refused while this node holds its own address: propagation only ever runs from the holder outwards,
 * and this is what stops a standby rewriting the node that actually has the address. An unchanged
 * value is dropped rather than rewritten, which is also what stops two nodes echoing a clear at each
 * other forever. */
const receiveConfiguration = async (received, module) => {
	const current = await readConfiguration();
	if (current?.address && await holdsAddress(current.address)) {
		return;
	}

	if ((current?.address || null) === (received?.address || null) && (current?.netmask || null) === (received?.netmask || null)) {
		return;
	}

	await storeConfiguration(received, module);
};

/** Best effort, and deliberately not awaited by whatever changed the address: a peer that is switched
 * off must not make configuring a virtual IP fail. Peers missed here are caught when they next appear
 * on the network and reconcile. */
const propagate = async (module) => {
	const configuration = await readConfiguration();
	if (configuration?.address && !await holdsAddress(configuration.address)) {
		return;
	}

	await peer.broadcast('virtualIp:configure', {
		virtualIp: (configuration?.address ? { address: configuration.address, netmask: configuration.netmask } : null)
	});
};

const promote = async (job, module) => {
	const configuration = await readConfiguration();
	if (!configuration?.address) {
		throw new Error(`No virtual IP is configured on this node.`);
	}

	if (await holdsAddress(configuration.address)) {
		return `${configuration.address} is already held by this node.`;
	}

	const holder = await peer.findHolder(configuration.address);
	if (holder) {
		await module.updateJobProgress(job, `Asking ${holder.name || holder.address} to release ${configuration.address}...`);
		await peer.call(holder.id, 'virtualIp:release');
		if (!await waitForRelease(configuration.address)) {
			throw new Error(`${holder.name || holder.address} did not release ${configuration.address}.`);
		}
	}

	await module.updateJobProgress(job, `Claiming ${configuration.address}...`);
	await writeEnvironmentFile(configuration);
	await claim(configuration.address);
	module.eventEmitter.emit('host:network:virtualIp:updated');
	return `${configuration.address} is now held by this node.`;
};

/** The mirror of taking over, and deliberately not a local release: letting go first would leave the
 * address unheld if the other node could not be reached. Asking it to take over instead means it runs
 * its own promote, which asks this node to release and only then claims — so a peer that cannot be
 * reached leaves the address exactly where it was. */
const handover = async (job, module) => {
	const { config } = job.data;
	const configuration = await readConfiguration();
	if (!configuration?.address) {
		throw new Error(`No virtual IP is configured on this node.`);
	}

	if (!await holdsAddress(configuration.address)) {
		throw new Error(`This node is not holding ${configuration.address}.`);
	}

	await module.updateJobProgress(job, `Handing ${configuration.address} over...`);
	await peer.call(config.peerId, 'virtualIp:promote');
	return `${configuration.address} handed over.`;
};

const release = async (job, module) => {
	const configuration = await readConfiguration();
	if (!configuration?.address) {
		throw new Error(`No virtual IP is configured on this node.`);
	}

	await module.updateJobProgress(job, `Releasing ${configuration.address}...`);
	await standDown();
	module.eventEmitter.emit('host:network:virtualIp:updated');
	return `${configuration.address} released.`;
};

/** Bringing bond0 up flushes its addresses, so a network change silently drops the virtual IP unless
 * the unit is restarted behind it. keepalived did this by itself; this is the replacement. */
const reassert = async (module) => {
	const configuration = await readConfiguration();
	if (!configuration?.address || !await isEnabled()) {
		return;
	}

	try {
		await execa('systemctl', ['restart', UNIT]);
		module.eventEmitter.emit('host:network:virtualIp:updated');
	} catch (error) {
		console.warn(`Could not re-assert the virtual IP: ${error.shortMessage || error.message}`);
	}
};

/** The unit's own announcement can be lost at boot: bond0 is created with updelay=10000, so the link
 * may not carry traffic when ExecStartPost runs. Re-announcing once virgo-api is up leaves the
 * router's ARP cache correct either way. */
const announce = async () => {
	const configuration = await readConfiguration();
	if (!configuration?.address || !await holdsAddress(configuration.address)) {
		return;
	}

	try {
		await execa('arping', ['-U', '-q', '-c', '3', '-I', configuration.device || BOND_NAME, configuration.address]);
	} catch (error) {
		console.warn(`Could not announce the virtual IP: ${error.shortMessage || error.message}`);
	}
};

const onConnection = (socket, module) => {
	socket.on('host:network:virtualIp:promote', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:network:virtualIp:promote', { username: socket.username });
	});
	socket.on('host:network:virtualIp:handover', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:network:virtualIp:handover', { config, username: socket.username });
	});
};

const register = (module) => {
	announce();
	module.eventEmitter.on('host:peer:virtualIp:received', (received) => { adoptConfiguration(received, module); });
	module.eventEmitter.on('host:peer:virtualIp:configure', (received) => { receiveConfiguration(received, module); });
	module.eventEmitter.on('host:network:virtualIp:updated', () => { propagate(module); });
	module.eventEmitter.on('host:network:interface:updated', () => { reassert(module); });
};

export default {
	name: 'virtual_ip',
	register,
	onConnection,
	jobs: {
		'host:network:virtualIp:promote': promote,
		'host:network:virtualIp:handover': handover,
		'host:network:virtualIp:release': release
	}
};

export { apply, validate, validateAgainstPeers, readConfiguration, isEnabled };
