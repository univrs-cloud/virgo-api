const fs = require('fs');
const { execa } = require('execa');

const DEFAULT_DNS_SERVER = '1.1.1.1';
const BOND_NAME = 'bond0';
const PRIMARY_INTERFACE = 'eth0';
const SECONDARY_INTERFACE = 'eth1';

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

const getDnsSearchFromConnection = async (connectionName) => {
	try {
		const { stdout } = await execa('nmcli', ['-g', 'ipv4.dns-search', 'connection', 'show', connectionName]);
		const dnsSearch = stdout.trim();
		return dnsSearch || null;
	} catch (error) {
		return null;
	}
};

const getCurrentIPv4Address = async () => {
	try {
		const { stdout: routeOutput } = await execa('ip', ['-j', 'route', 'show', 'default']);
		const routes = JSON.parse(routeOutput);
		const defaultDev = routes[0]?.dev;
		if (!defaultDev) {
			return null;
		}
		const { stdout: addrOutput } = await execa('ip', ['-j', 'addr', 'show', defaultDev]);
		const addresses = JSON.parse(addrOutput);
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
	await fs.promises.writeFile(module.etcHosts, configuration, 'utf8');
};

const updateIdentifier = async (job, module) => {
	const { config } = job.data;
	const system = module.getState('system');
	await module.updateJobProgress(job, `Host updating...`);
	try {
		const defaultInterface = system.networkInterfaces?.find((iface) => { return iface.default; });
		const connectionName = await getConnectionNameForInterface(defaultInterface.ifname);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns-search', config.domainName]);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns', DEFAULT_DNS_SERVER]);
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', connectionName]);
		await execa('hostnamectl', ['set-hostname', config.hostname]);
		const ipv4Info = defaultInterface.addrInfo?.find((info) => { return info.family === 'inet'; });
		const ip = ipv4Info?.local || '';
		const fqdn = `${config.hostname}.${config.domainName}`;
		await updateEtcHosts(module, ip, config.hostname, fqdn);
		await sleep(1000);
	} catch (error) {
		throw new Error(`Host was not updated.`);
	}
	
	module.eventEmitter.emit('host:network:identifier:updated');
	return `Host updated.`;
};

const createBondConnection = async () => {
	const bondOptions = `mode=active-backup,miimon=100,primary=${PRIMARY_INTERFACE}`;
	await execa('nmcli', ['connection', 'add', 'type', 'bond', 'con-name', BOND_NAME, 'ifname', BOND_NAME, 'bond.options', bondOptions]);
};

const updateBondConnection = async (config) => {
	const args = ['connection', 'modify', BOND_NAME, 'ipv4.method', config.method];
	if (config.method === 'manual') {
		args.push('ipv4.addresses', `${config.ipAddress}/${config.netmask}`);
		args.push('ipv4.gateway', config.gateway);
	} else {
		args.push('ipv4.addresses', '');
		args.push('ipv4.gateway', '');
	}
	args.push('ipv4.dns', DEFAULT_DNS_SERVER);
	await execa('nmcli', args);
};

const addBondSlave = async (interfaceName) => {
	const slaveName = `${BOND_NAME}-${interfaceName}`;
	
	if (await connectionExists(slaveName)) {
		return true;
	}
	
	try {
		await execa('nmcli', ['connection', 'add', 'type', 'ethernet', 'con-name', slaveName, 'ifname', interfaceName, 'master', BOND_NAME]);
		return true;
	} catch (error) {
		return false;
	}
};

const updateInterface = async (job, module) => {
	const { config } = job.data;
	const system = module.getState('system');
	await module.updateJobProgress(job, `Network interface updating...`);
	try {
		const bondExists = await connectionExists(BOND_NAME);
		const eth0ConnectionName = await getConnectionNameForInterface(PRIMARY_INTERFACE);
		const eth1ConnectionName = await getConnectionNameForInterface(SECONDARY_INTERFACE);
		if (!bondExists) {
			let dnsSearch = null;
			if (eth0ConnectionName && !eth0ConnectionName.startsWith(`${BOND_NAME}-`)) {
				dnsSearch = await getDnsSearchFromConnection(eth0ConnectionName);
			}
			if (eth0ConnectionName && !eth0ConnectionName.startsWith(`${BOND_NAME}-`)) {
				await deleteConnection(eth0ConnectionName);
			}
			if (eth1ConnectionName && !eth1ConnectionName.startsWith(`${BOND_NAME}-`)) {
				await deleteConnection(eth1ConnectionName);
			}
			await createBondConnection();
			if (dnsSearch) {
				await execa('nmcli', ['connection', 'modify', BOND_NAME, 'ipv4.dns-search', dnsSearch]);
			}
		}
		await updateBondConnection(config);
		await addBondSlave(PRIMARY_INTERFACE);
		await addBondSlave(SECONDARY_INTERFACE);
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', BOND_NAME]);
		let ip = config.ipAddress;
		if (config.method !== 'manual') {
			await sleep(2000); // Wait for DHCP
			ip = await getCurrentIPv4Address();
		}
		await updateEtcHosts(module, ip, system.osInfo.hostname, system.osInfo.fqdn);
		await sleep(1000);
	} catch (error) {
		throw new Error(`Network interface was not updated.`);
	}
	module.eventEmitter.emit('host:network:interface:updated');
	return `Network interface updated.`;
};

const onConnection = (socket, module) => {
	socket.on('host:network:identifier:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:network:identifier:update', { config, username: socket.username });
	});
	socket.on('host:network:interface:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:network:interface:update', { config, username: socket.username });
	});
};

module.exports = {
	name: 'network',
	// register, // can't use register to load and emit on change because network is part of system state
	onConnection,
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:interface:update': updateInterface
	}
};
