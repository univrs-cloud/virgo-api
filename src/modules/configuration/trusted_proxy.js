const DataService = require('../../database/data_service');

const loadTrustedProxiesList = async () => {
	const trustedProxies = (await DataService.getConfiguration()).trustedProxies;
	if (!Array.isArray(trustedProxies)) {
		return [];
	}

	return trustedProxies;
};

const addTrustedProxy = async (job, module) => {
	const { config } = job.data;
	const address = (typeof config?.address === 'string' ? config.address.trim() : '');
	if (!address) {
		throw new Error(`Trusted proxy add requires non-empty string config.address.`);
	}

	const trustedProxies = await loadTrustedProxiesList();
	if (trustedProxies.includes(address)) {
		throw new Error(`Trusted proxy ${address} already exists.`);
	}

	await module.updateJobProgress(job, `Adding trusted proxy ${address}...`);
	trustedProxies.push(address);
	if (!(await DataService.setConfiguration('trustedProxies', trustedProxies))) {
		throw new Error(`Failed to save trusted proxies.`);
	}

	module.eventEmitter.emit('configuration:updated');
	return `Trusted proxy ${address} added.`;
};

const updateTrustedProxy = async (job, module) => {
	const { config } = job.data;
	const fromAddress = (typeof config?.fromAddress === 'string' ? config.fromAddress.trim() : '');
	const toAddress = (typeof config?.toAddress === 'string' ? config.toAddress.trim() : '');
	if (!fromAddress || !toAddress) {
		throw new Error(`Trusted proxy update requires non-empty string config.fromAddress and config.toAddress.`);
	}

	const list = await loadTrustedProxiesList();
	const idx = list.indexOf(fromAddress);
	if (idx === -1) {
		throw new Error(`Trusted proxy ${fromAddress} not found.`);
	}

	if (list.includes(toAddress) && toAddress !== fromAddress) {
		throw new Error(`Trusted proxy ${toAddress} already exists.`);
	}
	
	await module.updateJobProgress(job, `Updating trusted proxy ${fromAddress} to ${toAddress}...`);
	list[idx] = toAddress;
	if (!(await DataService.setConfiguration('trustedProxies', list))) {
		throw new Error(`Failed to save trusted proxies.`);
	}

	module.eventEmitter.emit('configuration:updated');
	return `Trusted proxy ${fromAddress} updated to ${toAddress}.`;
};

const deleteTrustedProxy = async (job, module) => {
	const { config } = job.data;
	const address = (typeof config?.address === 'string' ? config.address.trim() : '');
	if (!address) {
		throw new Error(`Trusted proxy delete requires non-empty string config.address.`);
	}

	const trustedProxies = await loadTrustedProxiesList();
	const idx = trustedProxies.findIndex((proxy) => {
		return proxy === address;
	});
	if (idx === -1) {
		throw new Error(`Trusted proxy ${address} not found.`);
	}

	await module.updateJobProgress(job, `Removing trusted proxy ${address}...`);
	const next = trustedProxies.toSpliced(idx, 1);
	if (!(await DataService.setConfiguration('trustedProxies', next))) {
		throw new Error(`Failed to save trusted proxies.`);
	}

	module.eventEmitter.emit('configuration:updated');
	return `Trusted proxy ${address} deleted.`;
};

const onConnection = (socket, module) => {
	socket.on('configuration:trustedProxy:add', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('trustedProxy:add', { config, username: socket.username });
	});
	socket.on('configuration:trustedProxy:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('trustedProxy:update', { config, username: socket.username });
	});
	socket.on('configuration:trustedProxy:delete', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('trustedProxy:delete', { config, username: socket.username });
	});
};

module.exports = {
	name: 'trusted_proxy',
	onConnection,
	jobs: {
		'trustedProxy:add': addTrustedProxy,
		'trustedProxy:update': updateTrustedProxy,
		'trustedProxy:delete': deleteTrustedProxy
	}
};
