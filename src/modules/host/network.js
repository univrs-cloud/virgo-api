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
		const connectionName = await getConnectionNameForInterface(system.networkInterface.ifaceName);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.dns-search', config.domainName]);
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', connectionName]);
		await execa('hostnamectl', ['set-hostname', config.hostname]);
		await updateEtcHosts(module, system.networkInterface.ip4, config.hostname, `${config.hostname}.${config.domainName}`);
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
		const connectionName = await getConnectionNameForInterface(system.networkInterface.ifaceName);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.method', config.method]);
		if (config.method === 'manual') {
			await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.addresses', `${config.ipAddress}/${config.netmask}`]);
			await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.gateway', config.gateway]);
		}
		await execa('nmcli', ['connection', 'reload']);
		await execa('nmcli', ['connection', 'up', connectionName]);
		await updateEtcHosts(module, config.ipAddress, system.osInfo.hostname, system.osInfo.fqdn);
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

/*
nmcli con delete "Wired connection 1" && \
nmcli con delete "Wired connection 2" && \
nmcli con add type bond con-name bond0 ifname bond0 bond.options "mode=active-backup,miimon=100,primary=eth0" && \
nmcli con mod bond0 ipv4.addresses "192.168.100.3/24" ipv4.gateway "192.168.100.1" ipv4.dns "192.168.100.2" ipv4.dns-search "univrs" ipv4.method manual && \
nmcli con add type ethernet con-name bond0-eth1 ifname eth1 master bond0 && \
nmcli con add type ethernet con-name bond0-eth0 ifname eth0 master bond0 && \
nmcli con up bond0
*/