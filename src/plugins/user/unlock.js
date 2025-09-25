const { execa } = require('execa');

const unlockUser = async (job, plugin) => {
	let config = job.data.config;
	let user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	await plugin.updateJobProgress(job, `Unlocking system user ${config.username}...`);
	await execa('passwd', ['-u', config.username]);
	await plugin.updateJobProgress(job, `Unlocking Samba user ${config.username}...`);
	await execa('smbpasswd', ['-e', config.username]);
	await plugin.updateJobProgress(job, `Unlocking Authelia user ${config.username}...`);
	await plugin.toggleAutheliaUserLock(config.username, false);
	await plugin.emitUsers();
	return `${config.username} unlocked.`;
};

module.exports = {
	name: 'unlock',
	onConnection(socket, plugin) {
		socket.on('user:unlock', async (config) => {
			await plugin.handleUserAction(socket, 'user:unlock', config);
		});
	},
	jobs: {
		'user:unlock': unlockUser
	}
};
