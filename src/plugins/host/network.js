const { execa } = require('execa');

const updateIdentifier = async (job, plugin) => {
	let config = job.data.config;
	// config.hostname
	// config.domainName
	try {
		await execa('true');
	} catch (error) {
		throw new Error(`Host was not updated.`);
	}
	plugin.getInternalEmitter().emit('host:network:identifier:updated');
	return `Host updated.`;
};

const updateInnterface = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Network interface updating...`);
	try {
		const connectionName = await getConnectionNameForInterface(config.name);
		await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.method', config.method]);
		if (config.method === 'manual') {
			await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.addresses', `${config.ipAddress}/${config.netmask}`]);
			await execa('nmcli', ['connection', 'modify', connectionName, 'ipv4.gateway', config.gateway]);
		}
		await execa('nmcli', ['connection', 'reload']);
    	await execa('nmcli', ['connection', 'up', connectionName]);
		await waitForConnection(connectionName);
		plugin.getInternalEmitter().emit('host:network:interface:updated');
		await sleep(5000);
	} catch (error) {
		plugin.getInternalEmitter().emit('host:network:interface:updated');
		throw new Error(`Network interface was not updated.`);
	}
	return `Network interface updated.`;
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

async function waitForConnection(connectionName, timeoutMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const { stdout } = await execa('nmcli', ['-t', '-f', 'NAME,STATE', 'connection', 'show', '--active']);
			const lines = stdout.split('\n');
			const isActive = lines.some((line) => {
				const [name, state] = line.split(':');
				return name === connectionName && state === 'activated';
			});

			if (isActive) {
				return true;
			}
		} catch (error) {
			console.error(`Failed to check connection state:`, error);
		}

		await sleep(500); // retry every 0.5s
	}

	throw new Error(`Timeout waiting for connection "${connectionName}" to activate.`);
}

module.exports = {
	name: 'system_actions',
	onConnection(socket, plugin) {
		socket.on('host:network:identifier:update', async (config) => { 
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('host:network:identifier:update', { config, username: socket.username });
		});
		socket.on('host:network:interface:update', async (config) => { 
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('host:network:interface:update', { config, username: socket.username });
		});
	},
	jobs: {
		'host:network:identifier:update': updateIdentifier,
		'host:network:interface:update': updateInnterface
	}
};
