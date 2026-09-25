import fs from 'fs/promises';
import { execa } from 'execa';
import validator from 'validator';
import appConfig from '../../../config.js';
import DataService from '../../database/data_service.js';
import { checkDomainAvailability } from '../configuration/fleet.js';
import { BOND_NAME, getPhysicalInterfaceNames, getDefaultInterfaceName, isAddressInUse } from '../../utils/network.js';
import * as setup from '../../utils/setup_state.js';
import * as discovery from './discovery.js';

const DEFAULT_DNS_SERVER = '1.1.1.1';
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const FLEET_ZONE = appConfig.fleet.zone;
const RESERVED_CLUSTER_NAMES = new Set([
	'fleet', 'apps', 'packages', 'www', 'api', 'auth', 'admin', 'mail', 'smtp', 'imap',
	'ns', 'ns1', 'ns2', 'mx', 'traefik', 'status', 'docs', 'blog', 'cdn', 'static'
]);
const RESERVED_NODE_NAMES = new Set([
	'analytics', 'auth', 'autoconfig', 'autodiscover', 'dockhand', 'euro-office', 'gitea', 'mail',
	'nextcloud', 'pihole', 'rspamd', 'talk', 'terminal', 'torrent', 'traefik', 'vpn'
]);
const FALLBACK_INTERFACES = ['eth0', 'eth1'];
const BOND_SLAVE_LIMIT = 2;
const BOND_SLAVES_PATH = `/sys/class/net/${BOND_NAME}/bonding/slaves`;
const WAIT_DEVICE_TIMEOUT = '10000';

// Bringing the connection back up drops the browser watching this job, and a job that finishes while
// nothing is listening takes its result with it. Held open after the last thing that touches the link
// and before the node reads itself back, so the addressing has settled by the time it describes itself
// and the browser is there to be told.
const RECONNECT_GRACE_MS = 10000;
// A manual address is on the connection the moment it comes up; a leased one has to be asked for.
const DHCP_LEASE_WAIT_MS = 2000;

const sleep = (ms) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};

const getConnectionNameForInterface = async (interfaceName) => {
	try {
		const { stdout } = await execa('nmcli', ['-t', '-f', 'NAME,DEVICE', 'connection', 'show']);
		const suffix = `:${interfaceName}`;
		const line = stdout.trim().split('\n').filter(Boolean).find((line) => { return line.endsWith(suffix); });
		return line ? line.slice(0, -suffix.length) : null;
	} catch (error) {
		return null;
	}
};

const connectionExists = async (connectionName) => {
	try {
		const { stdout } = await execa('nmcli', ['-g', 'NAME', 'connection', 'show']);
		return stdout.trim().split('\n').filter(Boolean).includes(connectionName);
	} catch (error) {
		return false;
	}
};

const getConnectionProperty = async (connectionName, property) => {
	try {
		const { stdout } = await execa('nmcli', ['-g', property, 'connection', 'show', connectionName]);
		return stdout.trim() || null;
	} catch (error) {
		return null;
	}
};

const getCurrentIPv4Address = async () => {
	try {
		const defaultDev = await getDefaultInterfaceName();
		if (!defaultDev) {
			return null;
		}
		const { stdout: addrOutput } = await execa('ip', ['-j', 'addr', 'show', defaultDev]);
		const addresses = JSON.parse(addrOutput || '[]');
		const ipv4Info = addresses[0]?.addr_info?.find((info) => { return info.family === 'inet'; });
		return ipv4Info?.local || null;
	} catch (error) {
		return null;
	}
};

const deleteConnection = async (connectionName) => {
	if (!connectionName) {
		return false;
	}

	try {
		await execa('nmcli', ['connection', 'delete', connectionName]);
		return true;
	} catch (error) {
		return false;
	}
};

const updateEtcHosts = async (module, ip, hostname, fqdn) => {
	const configuration = `127.0.0.1	localhost
::1		localhost ip6-localhost ip6-loopback
ff02::1		ip6-allnodes
ff02::2		ip6-allrouters

127.0.1.1	${fqdn} ${hostname}
${ip}	${fqdn} ${hostname}
`;
	await fs.writeFile(module.etcHosts, configuration, 'utf8');
};

const isFleetSubZone = (domainName) => {
	return String(domainName || '').trim().toLowerCase().endsWith(`.${FLEET_ZONE}`);
};

const isFleetZone = (domainName) => {
	return String(domainName || '').trim().toLowerCase() === FLEET_ZONE;
};

const assertIdentifierFormat = ({ hostname, cluster, domainName }) => {
	if (!HOSTNAME_PATTERN.test(hostname || '')) {
		throw new Error(`'${hostname}' is not a valid hostname, use letters, digits and hyphens only.`);
	}

	if (RESERVED_NODE_NAMES.has(String(hostname).toLowerCase())) {
		throw new Error(`'${hostname}' is used by an app, choose another hostname.`);
	}

	if (!HOSTNAME_PATTERN.test(cluster || '')) {
		throw new Error(`'${cluster}' is not a valid cluster name, use letters, digits and hyphens only.`);
	}

	if (!validator.isFQDN(domainName || '')) {
		throw new Error(`'${domainName}' is not a valid domain name, use one with a TLD, like example.com.`);
	}
};

const assertFleetNameAvailable = async (cluster) => {
	if (RESERVED_CLUSTER_NAMES.has(String(cluster || '').trim().toLowerCase())) {
		throw new Error(`${cluster}.${FLEET_ZONE} is already taken.`);
	}

	let availability = null;
	try {
		availability = await checkDomainAvailability(cluster);
	} catch (error) {
		throw new Error(`A ${FLEET_ZONE} name has to be checked with the fleet first, and it could not be reached (${error.message}). Try again once this node is online.`);
	}

	if (!availability?.available) {
		throw new Error(`${cluster}.${FLEET_ZONE} is already taken.`);
	}
};

const updateIdentifier = async (job, module) => {
	const { config } = job.data;
	if (isFleetSubZone(config.domainName)) {
		throw new Error(`Sub-domains of ${FLEET_ZONE} are not supported, use ${FLEET_ZONE} itself.`);
	}

	assertIdentifierFormat(config);

	if (isFleetZone(config.domainName)) {
		await assertFleetNameAvailable(config.cluster);
	}

	const domainName = `${config.cluster}.${config.domainName}`.toLowerCase();
	const clustered = discovery.discover().filter((node) => { return Boolean(node.cluster); });
	const joined = (clustered.find((node) => { return node.holdsVirtualIp; }) || clustered[0]);
	if (!setup.isCompleted() && joined && joined.cluster !== domainName) {
		throw new Error(`${joined.name || joined.address} is already in ${joined.cluster}. A node set up on this network joins that cluster.`);
	}

	const system = module.getState('system');
	const hostPrefix = `${system?.osInfo?.hostname}.`;
	const fqdn = String(system?.osInfo?.fqdn || '');
	const currentDomainName = (fqdn.startsWith(hostPrefix) ? fqdn.slice(hostPrefix.length).toLowerCase() : '');
	const hasPeers = Boolean(((await DataService.getConfiguration()).peers || []).length);
	if (setup.isCompleted() && hasPeers && currentDomainName.split('.').length >= 3 && currentDomainName !== domainName) {
		throw new Error(`This node has adopted nodes in ${currentDomainName}. Remove them to change the cluster.`);
	}

	await module.updateJobProgress(job, `Host updating...`);
	try {
		const defaultInterface = system.networkInterfaces?.find((iface) => { return iface.default; });
		const connectionName = await getConnectionNameForInterface(defaultInterface.ifname);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns-search', domainName]);
		// On DHCP the servers come from the lease, so only a manual connection needs a fallback
		const isManual = (await getConnectionProperty(connectionName, 'ipv4.method')) === 'manual';
		if (isManual && !await getConnectionProperty(connectionName, 'ipv4.dns')) {
			await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns', DEFAULT_DNS_SERVER]);
		}
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', connectionName]);
		await execa('hostnamectl', ['set-hostname', config.hostname]);
		const ipv4Info = defaultInterface.addrInfo?.find((info) => { return info.family === 'inet'; });
		const ip = ipv4Info?.local || '';
		const fqdn = `${config.hostname}.${domainName}`;
		await updateEtcHosts(module, ip, config.hostname, fqdn);
		await sleep(RECONNECT_GRACE_MS);
	} catch (error) {
		throw new Error(`Host was not updated.`);
	}
	
	module.eventEmitter.emit('host:network:identifier:updated');
	return `Host updated.`;
};

const normalizeDnsServers = (dnsServers) => {
	return (dnsServers || []).map((dnsServer) => { return dnsServer?.toString().trim(); }).filter(Boolean);
};

const getBondInterfaces = async () => {
	const interfaces = await getPhysicalInterfaceNames();
	return (interfaces.length > 0 ? interfaces : FALLBACK_INTERFACES).slice(0, BOND_SLAVE_LIMIT);
};

const getConfiguredBondPrimary = async () => {
	const bondOptions = await getConnectionProperty(BOND_NAME, 'bond.options');
	const option = (bondOptions || '').split(',').map((option) => { return option.trim(); }).find((option) => { return option.startsWith('primary='); });
	return option ? option.slice('primary='.length) : null;
};

const getBondPrimary = async (interfaces) => {
	const configured = await getConfiguredBondPrimary();
	if (configured && interfaces.includes(configured)) {
		return configured;
	}

	const defaultInterface = await getDefaultInterfaceName();
	if (defaultInterface && interfaces.includes(defaultInterface)) {
		return defaultInterface;
	}

	return interfaces[0];
};

const getBondOptions = (primaryInterface) => {
	return `mode=active-backup,primary=${primaryInterface},primary_reselect=failure,miimon=100,updelay=10000`;
};

const createBondConnection = async (primaryInterface) => {
	await execa('nmcli', ['connection', 'add', 'type', 'bond', 'con-name', BOND_NAME, 'ifname', BOND_NAME, 'bond.options', getBondOptions(primaryInterface)]);
};

const updateBondConnection = async (config, primaryInterface) => {
	await execa('nmcli', ['connection', 'modify', BOND_NAME, 'bond.options', getBondOptions(primaryInterface)]);
	const args = ['connection', 'modify', BOND_NAME, 'connection.autoconnect-slaves', 'yes', 'ipv4.method', config.method];
	if (config.method === 'manual') {
		const dnsServers = normalizeDnsServers(config.dnsServers);
		args.push('ipv4.addresses', `${config.ipAddress}/${config.netmask}`);
		args.push('ipv4.gateway', config.gateway);
		args.push('ipv4.dns', dnsServers.length > 0 ? dnsServers.join(',') : (await getConnectionProperty(BOND_NAME, 'ipv4.dns') || DEFAULT_DNS_SERVER));
		args.push('ipv4.ignore-auto-dns', 'yes');
	} else {
		args.push('ipv4.addresses', '');
		args.push('ipv4.gateway', '');
		args.push('ipv4.dns', '');
		args.push('ipv4.ignore-auto-dns', 'no');
	}
	await execa('nmcli', args);
};

const getBondSlaveNames = async () => {
	try {
		const slaves = await fs.readFile(BOND_SLAVES_PATH, 'utf8');
		return slaves.trim().split(/\s+/).filter(Boolean);
	} catch (error) {
		return null;
	}
};

const getBondSlaveConnectionNames = async () => {
	try {
		const { stdout } = await execa('nmcli', ['-g', 'NAME', 'connection', 'show']);
		return stdout.trim().split('\n').filter(Boolean).filter((name) => { return name.startsWith(`${BOND_NAME}-`); });
	} catch (error) {
		return [];
	}
};

const addBondSlave = async (interfaceName) => {
	const slaveName = `${BOND_NAME}-${interfaceName}`;
	if (!await connectionExists(slaveName)) {
		await execa('nmcli', ['connection', 'add', 'type', 'ethernet', 'con-name', slaveName, 'ifname', interfaceName, 'master', BOND_NAME]);
	}

	await execa('nmcli', ['connection', 'modify', slaveName, 'connection.wait-device-timeout', WAIT_DEVICE_TIMEOUT]);
	return slaveName;
};

const updateInterface = async (job, module) => {
	const { config } = job.data;
	const system = module.getState('system');
	// Moving onto an address another host already holds takes the node off the network the moment the
	// new configuration comes up, with no way left to reach it and undo.
	if (config.method === 'manual' && config.ipAddress !== await getCurrentIPv4Address()) {
		await module.updateJobProgress(job, `Checking ${config.ipAddress}...`);
		const addressInUse = await isAddressInUse(config.ipAddress);
		if (addressInUse === true) {
			throw new Error(`${config.ipAddress} is already in use on the network.`);
		}

		if (addressInUse === null) {
			await module.updateJobProgress(job, `Could not check whether ${config.ipAddress} is in use, continuing...`);
		}
	}

	const virtualIp = module.getPlugin('virtual_ip');

	if (config.method === 'manual') {
		virtualIp?.validateAgainstPeers(config);
	}

	if (config.virtualIp) {
		virtualIp?.validate(config.virtualIp, config);
	}

	const staleSlaveNames = await getBondSlaveNames();
	if (staleSlaveNames && staleSlaveNames.length === 0) {
		const names = [BOND_NAME, ...await getBondSlaveConnectionNames()].join(' ');
		throw new Error(`${BOND_NAME} exists with no ports. Delete it and retry: nmcli connection delete ${names}`);
	}

	await module.updateJobProgress(job, `Network interface updating...`);
	const interfaces = await getBondInterfaces();
	try {
		const primaryInterface = await getBondPrimary(interfaces);
		const connectionNames = new Map();
		for (const interfaceName of interfaces) {
			connectionNames.set(interfaceName, await getConnectionNameForInterface(interfaceName));
		}
		let dnsSearch = null;
		let dns = null;
		const primaryConnectionName = connectionNames.get(primaryInterface);
		if (primaryConnectionName && !primaryConnectionName.startsWith(`${BOND_NAME}-`)) {
			dnsSearch = await getConnectionProperty(primaryConnectionName, 'ipv4.dns-search');
			dns = await getConnectionProperty(primaryConnectionName, 'ipv4.dns');
		}
		if (!await connectionExists(BOND_NAME)) {
			await createBondConnection(primaryInterface);
		}
		if (dnsSearch && !await getConnectionProperty(BOND_NAME, 'ipv4.dns-search')) {
			await execa('nmcli', ['connection', 'modify', BOND_NAME, 'ipv4.dns-search', dnsSearch]);
		}
		if (dns && !await getConnectionProperty(BOND_NAME, 'ipv4.dns')) {
			await execa('nmcli', ['connection', 'modify', BOND_NAME, 'ipv4.dns', dns]);
		}
		await updateBondConnection(config, primaryInterface);
		const slaveConnectionNames = [];
		for (const interfaceName of interfaces) {
			slaveConnectionNames.push(await addBondSlave(interfaceName));
		}
		for (const connectionName of connectionNames.values()) {
			if (connectionName && !connectionName.startsWith(`${BOND_NAME}-`)) {
				await deleteConnection(connectionName);
			}
		}
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', BOND_NAME]);
		for (const slaveConnectionName of slaveConnectionNames) {
			await execa('nmcli', ['connection', 'up', slaveConnectionName]);
		}
		let ip = config.ipAddress;
		if (config.method !== 'manual') {
			await sleep(DHCP_LEASE_WAIT_MS);
			ip = await getCurrentIPv4Address();
		}
		await updateEtcHosts(module, ip, system.osInfo.hostname, system.osInfo.fqdn);
	} catch (error) {
		throw new Error(`Network interface was not updated.`);
	}

	const slaveNames = await getBondSlaveNames();
	if (!slaveNames || slaveNames.length === 0) {
		throw new Error(`Network interface was not updated. ${BOND_NAME} came up with no ports: ${interfaces.join(', ')} could not be enslaved.`);
	}

	await virtualIp?.apply(config.virtualIp, config, module);
	await sleep(RECONNECT_GRACE_MS);
	module.eventEmitter.emit('host:network:interface:updated');
	return `Network interface updated.`;
};

export default {
	name: 'network',
	commands: {
		'host:network:interface:update': { job: 'host:network:interface:update' },
		'host:network:identifier:update': { job: 'host:network:identifier:update' }
	},
	// register, // can't use register to load and emit on change because network is part of system state
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:interface:update': updateInterface
	}
};
