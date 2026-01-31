const fs = require('fs');
const path = require('path');
const ini = require('ini');
const { execa } = require('execa');

const slug = (comment) => {
	return (comment || '').toLowerCase().trim().replace(/\s+/g, '_');
};

const createTimeMachine = async (job, module) => {
	const { config } = job.data;
	const { comment, validUsers = [], refquota: refquotaRaw } = config;
	const dataset = `${module.timeMachinesDataset}/${slug(comment)}`;
	const refquota = (Number.isInteger(refquotaRaw) ? module.refquotaToZfsString(refquotaRaw) : 'none');
	await module.updateJobProgress(job, `Creating time machine ${comment}...`);
	await execa('zfs', ['create', '-o', `refquota=${refquota}`, dataset]);
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

	if (type === 'timeMachine') {
		return createTimeMachine(job, module);
	}

	// folder type not yet implemented
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
