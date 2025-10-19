const { execa } = require('execa');

const lockUser = async (job, plugin) => {
	const config = job.data.config;
	const user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be locked.`);
	}

	await plugin.updateJobProgress(job, `Locking system user ${config.username}...`);
	await execa('passwd', ['-l', config.username]);
	await plugin.updateJobProgress(job, `Locking Samba user ${config.username}...`);
	await execa('smbpasswd', ['-d', config.username]);
	await plugin.updateJobProgress(job, `Locking Authelia user ${config.username}...`);
	await plugin.toggleAutheliaUserLock(config.username, true);
	await plugin.emitUsers();
	return `${config.username} locked.`;
};

module.exports = {
	name: 'lock',
	onConnection(socket, plugin) {
		socket.on('user:lock', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await plugin.addJob('user:lock', { config, username: socket.username });
		});
	},
	jobs: {
		'user:lock': lockUser
	}
};
