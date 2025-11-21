const { execa } = require('execa');

const lockUser = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users')?.find((user) => { return user.username === config.username; });
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
	return `${config.username} locked.`;
};

const onConnection = (socket, module) => {
	socket.on('user:lock', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('user:lock', { config, username: socket.username });
	});
};

module.exports = {
	name: 'lock',
	onConnection,
	jobs: {
		'user:lock': lockUser
	}
};
