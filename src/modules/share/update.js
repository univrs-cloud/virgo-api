const fs = require('fs');
const ini = require('ini');
const { execa } = require('execa');

const updateTimeMachine = async (job, module) => {
	const { config } = job.data;
	const { name, validUsers = [], refquota: refquotaRaw } = config;
	const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
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
		throw new Error(`No dataset found for mountpoint "${share.path}".`);
	}

	await module.updateJobProgress(job, `Updating time machine ${name}...`);
	await execa('zfs', ['set', `refquota=${refquota}`, dataset]);
	share['valid users'] = validUsers.join(' ');
	fs.writeFileSync(module.timeMachinesConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Time machine ${name} updated.`;
};

const updateShare = async (job, module) => {
	const { config } = job.data;
	const { type } = config;
	const validTypes = ['folder', 'timeMachine'];
	if (!type || !validTypes.includes(type)) {
		throw new Error(`Share type is required and must be one of: ${validTypes.join(', ')}.`);
	}

	if (type === 'timeMachine') {
		return updateTimeMachine(job, module);
	}

	// folder type not yet implemented
	throw new Error(`Share type "${type}" is not yet implemented.`);
};

const onConnection = (socket, module) => {
	socket.on('share:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('share:update', { config, username: socket.username });
	});
};

module.exports = {
	name: 'update',
	onConnection,
	jobs: {
		'share:update': updateShare
	}
};
