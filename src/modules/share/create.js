const fs = require('fs');
const path = require('path');
const { execa } = require('execa');

const slug = (comment) => {
	return (comment || '').toLowerCase().trim().replace(/\s+/g, '_');
};

const refquotaToZfsString = (bytes) => {
	if (bytes >= 1024 ** 4) return `${Math.floor(bytes / 1024 ** 4)}T`;
	if (bytes >= 1024 ** 3) return `${Math.floor(bytes / 1024 ** 3)}G`;
	if (bytes >= 1024 ** 2) return `${Math.floor(bytes / 1024 ** 2)}M`;
	if (bytes >= 1024) return `${Math.floor(bytes / 1024)}K`;
	return `${bytes}`;
};

const createTimeMachineShare = async (job, module) => {
	const { config } = job.data;
	const { comment, validUsers = [], refquota: refquotaRaw } = config;
	const dataset = `${module.timeMachinesDatasetPrefix}/${slug(comment)}`;
	const refquota = (Number.isInteger(refquotaRaw) ? refquotaToZfsString(refquotaRaw) : 'none');
	const section = `[time_machine_${slug(comment)}]
    path = /time_machines/${slug(comment)}
    comment = ${comment}
    browseable = yes
    writable = yes
    read only = no
    guest ok = no
    create mask = 0775
    directory mask = 0755
    force user = root
    valid users = ${validUsers.join(' ')}
    enable time machine
    fruit:time machine = yes

`;
	await module.updateJobProgress(job, `Creating share ${comment}...`);
	await execa('zfs', ['create', '-o', `refquota=${refquota}`, dataset]);
	let existingConf = '';
	try {
		existingConf = fs.readFileSync(module.timeMachinesConf, 'utf8');
	} catch {
		// missing or unreadable: treat as empty and write new file
	}
	const dir = path.dirname(module.timeMachinesConf);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(module.timeMachinesConf, existingConf + section, 'utf8');
	await execa('smbcontrol', ['all', 'reload-config']);
	module.eventEmitter.emit('shares:updated');
	return `Share ${comment} created.`;
};

const createShare = async (job, module) => {
	const { config } = job.data;
	const { type } = config;
	const validTypes = ['folder', 'timeMachine'];
	if (!type || !validTypes.includes(type)) {
		throw new Error(`Share type is required and must be one of: ${validTypes.join(', ')}.`);
	}

	if (type === 'timeMachine') {
		return createTimeMachineShare(job, module);
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
