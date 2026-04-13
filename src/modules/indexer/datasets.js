const { execa } = require('execa');
const DataService = require('../../database/data_service');

const normalizeDataset = (dataset) => {
	if (typeof dataset !== 'string') {
		return null;
	}

	const name = dataset.trim();
	if (!name || /[\0\n\r]/.test(name)) {
		return null;
	}

	return name;
};

const zfsDatasetExists = async (name) => {
	try {
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'name', '-j', name]);
		const datasets = JSON.parse(zfsList)?.datasets || {};
		return Object.hasOwn(datasets, name);
	} catch {
		return false;
	}
};

const updateDatasetConfig = async (job, module) => {
	const { config } = job.data;
	if (config?.optedIn !== true && config?.optedIn !== false) {
		throw new Error('Invalid optedIn flag.');
	}

	const name = normalizeDataset(config?.dataset);
	if (!name) {
		throw new Error('Invalid dataset name.');
	}

	if (config.optedIn) {
		const ok = await zfsDatasetExists(name);
		if (!ok) {
			throw new Error(`Dataset does not exist on ZFS: ${name}`);
		}
	}
	const verb = config.optedIn ? 'Adding' : 'Removing';
	await module.updateJobProgress(job, `${verb} ${name} in indexer configuration...`);
	const configuration = await DataService.getConfiguration();
	let list = (configuration.indexer ?? [])
		.map((s) => {
			return s.trim();
		})
		.filter((s) => {
			return Boolean(s);
		});
	if (config.optedIn) {
		if (!list.includes(name)) {
			list = [...list, name];
		}
	} else {
		list = list.filter((entry) => {
			return entry !== name && !entry.startsWith(name + '/');
		});
	}
	const ok = await DataService.setConfiguration('indexer', list);
	if (!ok) {
		throw new Error('Failed to save indexer configuration.');
	}
	
	module.eventEmitter.emit('configuration:updated');
	return config.optedIn ? `${name} added to indexer list.` : `${name} removed from indexer list.`;
};

const onConnection = (socket, module) => {
	socket.on('indexer:dataset:config:update', (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		module.addJob('indexer:dataset:config:update', { config, username: socket.username });
	});
};

module.exports = {
	name: 'datasets',
	onConnection,
	jobs: {
		'indexer:dataset:config:update': updateDatasetConfig
	}
};
