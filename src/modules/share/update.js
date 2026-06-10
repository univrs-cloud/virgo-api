import fs from 'fs';
import ini from 'ini';
import { execa } from 'execa';

const updateFolder = async (job, module) => {
	const { config } = job.data;
	const { name, validUsers = [], refquota: refquotaRaw } = config;
	const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
	const shareConfigFile = await module.findFolderShareConfigFile(name);
	if (shareConfigFile === null) {
		throw new Error(`Folder "${name}" not found in config.`);
	}
	let shares = {};
	try {
		shares = ini.parse(fs.readFileSync(shareConfigFile, 'utf8'));
	} catch (error) {
		throw new Error(`Cannot read config: ${error.message}`);
	}
	const share = shares[name];
	if (!share?.path) {
		throw new Error(`Folder "${name}" has no path.`);
	}

	const dataset = await module.pathToZfsDataset(share.path);
	const customPath = (dataset === null ? share.path : null);

	await module.updateJobProgress(job, `Updating folder ${name}...`);
	if (dataset !== null) {
		await execa('zfs', ['set', `refquota=${refquota}`, dataset]);
	}
	share['guest ok'] = (validUsers.length === 0 ? 'yes' : 'no');
	share['valid users'] = validUsers.join(' ');
	fs.writeFileSync(shareConfigFile, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	if (customPath !== null) {
		await module.addJob('share:projectspace:apply', {
			sharePath: customPath,
			comment: share.comment
		});
	}
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
	if (Number.isInteger(refquotaRaw)) {
		share['fruit:time machine max size'] = refquota;
	} else {
		delete share['fruit:time machine max size'];
	}
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

export default {
	name: 'update',
	onConnection,
	jobs: {
		'share:update': updateShare
	}
};
