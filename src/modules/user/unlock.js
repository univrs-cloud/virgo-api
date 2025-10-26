const { execa } = require('execa');

const unlockUser = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	await module.updateJobProgress(job, `Unlocking system user ${config.username}...`);
	await execa('passwd', ['-u', config.username]);
	await module.updateJobProgress(job, `Unlocking Samba user ${config.username}...`);
	await execa('smbpasswd', ['-e', config.username]);
	await module.updateJobProgress(job, `Unlocking Authelia user ${config.username}...`);
	await module.toggleAutheliaUserLock(config.username, false);
	module.getInternalEmitter().emit('users:updated');
	return `${config.username} unlocked.`;
};

module.exports = {
	name: 'unlock',
	onConnection(socket, module) {
		socket.on('user:unlock', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await module.addJob('user:unlock', { config, username: socket.username });
		});
	},
	jobs: {
		'user:unlock': unlockUser
	}
};
