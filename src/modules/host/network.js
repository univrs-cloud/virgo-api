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
	const line = stdout
		.split('\n')
		.find((line) => line.endsWith(`:${name}`));
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
	module.getInternalEmitter().emit('host:network:identifier:updated');
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
	module.getInternalEmitter().emit('host:network:interface:updated');
	return `Network interface updated.`;
};

module.exports = {
	name: 'system_actions',
	onConnection(socket, module) {
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
	},
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:interface:update': updateInterface
	}
};
