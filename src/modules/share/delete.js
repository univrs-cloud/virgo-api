const fs = require('fs');
const ini = require('ini');
const { execa } = require('execa');

const deleteTimeMachine = async (job, module) => {
	const { config } = job.data;
	const { name } = config;
	let shares = {};
	try {
		shares = ini.parse(fs.readFileSync(module.timeMachinesConf, 'utf8'));
	} catch (error) {
		throw new Error(`Cannot read config: ${error.message}`);
	}
	
	const share = shares[name];
	if (!share) {
		throw new Error(`Time machine "${name}" not found in config.`);
	}

	if (!share.path) {
		throw new Error(`Time machine "${name}" has no path.`);
	}

	const dataset = await module.pathToZfsDataset(share.path);
	if (!dataset) {
		throw new Error(`Cannot derive dataset from path "${share.path}".`);
	}

	await module.updateJobProgress(job, `Deleting time machine ${name}...`);
	await execa('zfs', ['destroy', '-r', dataset]);
	delete shares[name];
	fs.writeFileSync(module.timeMachinesConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Time machine ${name} deleted.`;
};

const deleteShare = async (job, module) => {
	const { config } = job.data;
	const { type } = config;
	const validTypes = ['folder', 'timeMachine'];
	if (!type || !validTypes.includes(type)) {
		throw new Error(`Share type is required and must be one of: ${validTypes.join(', ')}.`);
	}

	if (type === 'timeMachine') {
		return deleteTimeMachine(job, module);
	}

	// folder type not yet implemented
	throw new Error(`Share type "${type}" is not yet implemented.`);
};

const onConnection = (socket, module) => {
	socket.on('share:delete', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('share:delete', { config, username: socket.username });
	});
};

module.exports = {
	name: 'delete',
	onConnection,
	jobs: {
		'share:delete': deleteShare
	}
};
