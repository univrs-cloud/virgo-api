const fs = require('fs');
const ini = require('ini');
const { execa } = require('execa');

const deleteFolder = async (job, module) => {
	const { config } = job.data;
	const { name } = config;
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
		throw new Error(`Folder "${share.comment}" has no path.`);
	}

	const customPath = (share.path.startsWith('/messier/folders/') ? null : share.path);
	const dataset = (customPath === null ? await module.pathToZfsDataset(share.path) : null);
	if (dataset === null && customPath === null) {
		throw new Error(`Cannot derive dataset from path "${share.path}".`);
	}
	
	await module.updateJobProgress(job, `Deleting folder ${share.comment}...`);
	if (dataset !== null) {
		await execa('zfs', ['destroy', '-r', dataset]);
	}
	delete shares[name];
	fs.writeFileSync(module.foldersConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	if (customPath !== null) {
		await module.addJob('share:projectspace:remove', {
			sharePath: customPath,
			comment: share.comment
		});
	}
	module.eventEmitter.emit('shares:updated');
	return `Folder ${share.comment} deleted.`;
};

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
		throw new Error(`Time machine "${share.comment}" has no path.`);
	}

	const path = (share.path.startsWith('/time_machines/') ? share.path : null);
	const dataset = await module.pathToZfsDataset(path);
	if (dataset === null) {
		throw new Error(`Cannot derive dataset from path "${share.path}".`);
	}

	await module.updateJobProgress(job, `Deleting time machine ${share.comment}...`);
	await execa('zfs', ['destroy', '-r', dataset]);
	delete shares[name];
	fs.writeFileSync(module.timeMachinesConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Time machine ${share.comment} deleted.`;
};

const deleteShare = async (job, module) => {
	const { config } = job.data;
	const { type } = config;
	const validTypes = ['folder', 'timeMachine'];
	if (!type || !validTypes.includes(type)) {
		throw new Error(`Share type is required and must be one of: ${validTypes.join(', ')}.`);
	}

	if (type === 'folder') {
		return deleteFolder(job, module);
	}

	if (type === 'timeMachine') {
		return deleteTimeMachine(job, module);
	}

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
