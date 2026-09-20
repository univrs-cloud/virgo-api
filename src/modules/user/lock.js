import { execa } from 'execa';

const lockUser = async (job, module) => {
	const { config } = job.data;
	const user = module.toArray(module.getState('users')).find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be locked.`);
	}

	await module.updateJobProgress(job, `Locking system user ${config.username}...`);
	await execa('passwd', ['-l', config.username]);
	await module.updateJobProgress(job, `Locking Samba user ${config.username}...`);
	await execa('smbpasswd', ['-d', config.username]);
	await module.updateJobProgress(job, `Locking Authelia user ${config.username}...`);
	await module.toggleAutheliaUserLock(config.username, true);
	module.eventEmitter.emit('users:updated');
	return `User ${config.username} locked.`;
};

export default {
	name: 'lock',
	commands: {
		'user:lock': { job: 'user:lock' }
	},
	jobs: {
		'user:lock': lockUser
	}
};
