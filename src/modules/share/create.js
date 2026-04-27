const fs = require('fs');
const path = require('path');
const ini = require('ini');
const { execa } = require('execa');

const slug = (comment) => {
	return (comment || '').toLowerCase().trim().replace(/\s+/g, '_');
};

const createFolder = async (job, module) => {
	const { config } = job.data;
	const { comment, validUsers = [], refquota: refquotaRaw, path: customPath } = config;
	await module.updateJobProgress(job, `Creating folder ${comment}...`);

	let sharePath;
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			throw new Error(`Path "${customPath}" does not exist.`);
		}
		sharePath = customPath;
	} else {
		const dataset = `${module.foldersDataset}/${slug(comment)}`;
		const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
		const { exitCode: datasetExists } = await execa('zfs', ['list', dataset], { reject: false });
		if (datasetExists !== 0) {
			await execa('zfs', ['create', '-o', `refquota=${refquota}`, dataset]);
		}
		sharePath = `/messier/folders/${slug(comment)}`;
	}

	let shares = {};
	try {
		const existingConf = fs.readFileSync(module.foldersConf, 'utf8');
		shares = ini.parse(existingConf);
	} catch {
		// missing or unreadable: treat as empty and write new file
	}
	if (customPath) {
		const existingKey = Object.keys(shares).find((key) => { return shares[key].path === customPath; });
		if (existingKey && existingKey !== slug(comment)) {
			delete shares[existingKey];
		}
	}
	const nextcloudPath = isNextcloudCustomPath(customPath);
	shares[`${slug(comment)}`] = {
		path: sharePath,
		comment,
		'browseable': 'yes',
		'writable': 'yes',
		'read only': 'no',
		'guest ok': (validUsers.length === 0 ? 'yes' : 'no'),
		'create mask': '0775',
		'directory mask': '0755',
		'force user': (nextcloudPath ? 'voyager' : 'root'),
		...(nextcloudPath ? { 'force group': 'users' } : {}),
		'valid users': validUsers.join(' ')
	};
	const dir = path.dirname(module.foldersConf);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(module.foldersConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Folder ${comment} created.`;

	function isNextcloudCustomPath(pathToCheck) {
		const NEXTCLOUD_DATA_PATH_PREFIX = '/messier/apps/nextcloud/data/';
		return typeof pathToCheck === 'string' && pathToCheck.startsWith(NEXTCLOUD_DATA_PATH_PREFIX);
	}
};

const createTimeMachine = async (job, module) => {
	const { config } = job.data;
	const { comment, validUsers = [], refquota: refquotaRaw } = config;
	const dataset = `${module.timeMachinesDataset}/${slug(comment)}`;
	const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
	await module.updateJobProgress(job, `Creating time machine ${comment}...`);
	const { exitCode: datasetExists } = await execa('zfs', ['list', dataset], { reject: false });
	if (datasetExists !== 0) {
		await execa('zfs', ['create', '-o', `refquota=${refquota}`, dataset]);
	}
	let shares = {};
	try {
		const existingConf = fs.readFileSync(module.timeMachinesConf, 'utf8');
		shares = ini.parse(existingConf);
	} catch {
		// missing or unreadable: treat as empty and write new file
	}
	shares[`time_machine_${slug(comment)}`] = {
		path: `/time_machines/${slug(comment)}`,
		comment,
		'browseable': 'yes',
		'writable': 'yes',
		'read only': 'no',
		'guest ok': 'no',
		'create mask': '0775',
		'directory mask': '0755',
		'force user': 'root',
		'valid users': validUsers.join(' '),
		'enable time machine': 'yes',
		'fruit:time machine': 'yes'
	};
	const dir = path.dirname(module.timeMachinesConf);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(module.timeMachinesConf, ini.stringify(shares), 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Time machine ${comment} created.`;
};

const createShare = async (job, module) => {
	const { config } = job.data;
	const { type } = config;
	const validTypes = ['folder', 'timeMachine'];
	if (!type || !validTypes.includes(type)) {
		throw new Error(`Share type is required and must be one of: ${validTypes.join(', ')}.`);
	}

	if (type === 'folder') {
		return createFolder(job, module);
	}

	if (type === 'timeMachine') {
		return createTimeMachine(job, module);
	}

	throw new Error(`Share type "${type}" is not yet implemented.`);
};

const onConnection = (socket, module) => {
	socket.on('share:create', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('share:create', { config, username: socket.username });
	});
};

module.exports = {
	name: 'create',
	onConnection,
	jobs: {
		'share:create': createShare
	}
};
