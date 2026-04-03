const fs = require('fs');
const ini = require('ini');
const { execa } = require('execa');

const updateFolder = async (job, module) => {
	const { config } = job.data;
	const { name, validUsers = [], refquota: refquotaRaw } = config;
	const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
	let shares = {};
	try {
		shares = ini.parse(fs.readFileSync(module.foldersConf, 'utf8'));
	} catch (error) {
		throw new Error(`Cannot read config: ${error.message}`);
	}

	const share = shares[name];
	if (!share) {
		throw new Error(`Folder "${name}" not found in config.`);
	}

	if (!share.path) {
		throw new Error(`Folder "${name}" has no path.`);
	}

	const path = (share.path.startsWith('/messier/folders/') ? share.path : null);
	const dataset = await module.pathToZfsDataset(path);
	if (dataset === null && path !== null) {
		throw new Error(`No dataset found for mountpoint "${share.path}".`);
	}

	await module.updateJobProgress(job, `Updating folder ${name}...`);
	if (dataset !== null) {
		await execa('zfs', ['set', `refquota=${refquota}`, dataset]);
	}
	share['valid users'] = validUsers.join(' ');
	fs.writeFileSync(module.foldersConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Folder ${name} updated.`;
};

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

	const path = (share.path.startsWith('/time_machines/') ? share.path : null);
	const dataset = await module.pathToZfsDataset(path);
	if (dataset === null) {
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

	if (type === 'folder') {
		return updateFolder(job, module);
	}

	if (type === 'timeMachine') {
		return updateTimeMachine(job, module);
	}

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
