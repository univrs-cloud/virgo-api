const fs = require('fs');
const { execa } = require('execa');

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

const getConnectionNameForInterface = async (name) => {
	const { stdout } = await execa('nmcli', ['-t', '-f', 'NAME,DEVICE', 'connection', 'show']);
	const line = stdout.split('\n').find((line) => line.endsWith(`:${name}`));
	return line?.split(':')[0];
};

const connectionExists = async (connectionName) => {
	try {
		const { stdout } = await execa('nmcli', ['-t', '-f', 'NAME', 'connection', 'show']);
		return stdout.split('\n').includes(connectionName);
	} catch (error) {
		return false;
	}
};

const getDnsSearchFromConnection = async (connectionName) => {
	try {
		const { stdout } = await execa('nmcli', ['-t', '-f', 'ipv4.dns-search', 'connection', 'show', connectionName]);
		const dnsSearch = stdout.trim();
		return dnsSearch || null;
	} catch (error) {
		return null;
	}
};

const sleep = (ms) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};

const updateIdentifier = async (job, module) => {
	const config = job.data.config;
	const system = module.getState('system');
	await module.updateJobProgress(job, `Host updating...`);
	try {
		const defaultInterface = system.networkInterfaces?.find((iface) => { return iface.default; });
		if (!defaultInterface) {
			throw new Error('No default network interface found');
		}

		const connectionName = await getConnectionNameForInterface(defaultInterface.ifname);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns-search', config.domainName]);
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', connectionName]);
		await execa('hostnamectl', ['set-hostname', config.hostname]);
		
		let ip4 = '';
		if (defaultInterface.addrInfo) {
			const ipv4Info = defaultInterface.addrInfo.find(info => info.family === 'inet');
			if (ipv4Info) {
				ip4 = ipv4Info.local || '';
			}
		}
		await updateEtcHosts(module, ip4, config.hostname, `${config.hostname}.${config.domainName}`);
		await sleep(1000);
	} catch (error) {
		throw new Error(`Host was not updated.`);
	}
	module.eventEmitter.emit('host:network:identifier:updated');
	return `Host updated.`;
};

const updateInterface = async (job, module) => {
	const config = job.data.config;
	const system = module.getState('system');
	await module.updateJobProgress(job, `Network interface updating...`);
	try {
		// Create a bond with eth0 and eth1 (if available)
		// eth0 always exists, eth1 only exists if USB adapter is connected
		const bondName = 'bond0';
		
		// Get connection names for interfaces
		const eth0ConnectionName = await getConnectionNameForInterface('eth0');
		const eth1ConnectionName = await getConnectionNameForInterface('eth1');
		
		// Get DNS search domain from eth0 before deleting it (only if creating bond)
		const bondExists = await connectionExists(bondName);
		let eth0DnsSearch = null;
		if (!bondExists && eth0ConnectionName && !eth0ConnectionName.startsWith(`${bondName}-`)) {
			eth0DnsSearch = await getDnsSearchFromConnection(eth0ConnectionName);
		}
		
		// Delete existing standalone connections (not slaves of bond)
		// Only delete if they're not already slave connections
		if (eth0ConnectionName && !eth0ConnectionName.startsWith(`${bondName}-`)) {
			try {
				await execa('nmcli', ['connection', 'delete', eth0ConnectionName]);
			} catch (error) {
				// Connection might not exist, continue
			}
		}
		if (eth1ConnectionName && !eth1ConnectionName.startsWith(`${bondName}-`)) {
			try {
				await execa('nmcli', ['connection', 'delete', eth1ConnectionName]);
			} catch (error) {
				// Connection might not exist, continue
			}
		}
		
		// Create bond (always create, even if eth1 doesn't exist)
		// eth0 is always the primary interface
		if (!bondExists) {
			await execa('nmcli', [
				'connection', 'add',
				'type', 'bond',
				'con-name', bondName,
				'ifname', bondName,
				'bond.options', `mode=active-backup,miimon=100,primary=eth0`
			]);
		}
		
		// Configure bond with network settings
		const bondModifyArgs = ['connection', 'modify', bondName, 'ipv4.method', config.method];
		if (config.method === 'manual') {
			bondModifyArgs.push('ipv4.addresses', `${config.ipAddress}/${config.netmask}`);
			bondModifyArgs.push('ipv4.gateway', config.gateway);
		} else {
			// For DHCP/auto, clear any static IP configuration
			bondModifyArgs.push('ipv4.addresses', '');
			bondModifyArgs.push('ipv4.gateway', '');
		}
		// When creating the bond, preserve DNS search domain from eth0
		if (!bondExists && eth0DnsSearch) {
			bondModifyArgs.push('ipv4.dns-search', eth0DnsSearch);
		}
		await execa('nmcli', bondModifyArgs);
		
		// Always add eth0 as slave to the bond (if not already added)
		if (!(await connectionExists(`${bondName}-eth0`))) {
			await execa('nmcli', ['connection', 'add', 'type', 'ethernet', 'con-name', `${bondName}-eth0`, 'ifname', 'eth0', 'master', bondName]);
		}
		
		// Try to add eth1 as slave (if not already added and eth1 exists)
		if (!(await connectionExists(`${bondName}-eth1`))) {
			try {
				await execa('nmcli', ['connection', 'add', 'type', 'ethernet', 'con-name', `${bondName}-eth1`, 'ifname', 'eth1', 'master', bondName ]);
			} catch (error) {}
		}
		
		await execa('nmcli', ['connection', 'up', bondName]);
		
		let ipAddress = config.ipAddress;
		if (config.method !== 'manual') {
			await sleep(2000); // Wait for DHCP to assign IP
			try {
				const { stdout: routeOutput } = await execa('ip', ['-j', 'route', 'show', 'default']);
				const routes = JSON.parse(routeOutput);
				let defaultDev = null;
				if (routes.length > 0 && routes[0].dev) {
					defaultDev = routes[0].dev;
				}
				if (defaultDev) {
					const { stdout: addrOutput } = await execa('ip', ['-j', 'addr', 'show', defaultDev]);
					const addresses = JSON.parse(addrOutput);
					if (addresses.length > 0 && addresses[0].addr_info) {
						const ipv4Info = addresses[0].addr_info.find(info => info.family === 'inet');
						if (ipv4Info && ipv4Info.local) {
							ipAddress = ipv4Info.local;
						}
					}
				}
			} catch (error) {}
		}
		if (ipAddress) {
			await updateEtcHosts(module, ipAddress, system.osInfo.hostname, system.osInfo.fqdn);
		}
		
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
	// register, // can't user register to load and emit on change because network is part of system state
	onConnection,
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:interface:update': updateInterface
	}
};
