const fs = require('fs');
const { execa } = require('execa');
const yaml = require('js-yaml');
const linuxUser = require('linux-sys-user').promise();

const deleteUser = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users')?.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be deleted.`);
	}

	await module.updateJobProgress(job, `Deleting Authelia user ${config.username}...`);
	await deleteAutheliaUser();
	await module.updateJobProgress(job, `Deleting SMB user ${config.username}...`);
	await execa('smbpasswd', ['-s', '-x', config.username]);
	await module.updateJobProgress(job, `Deleting system user ${config.username}...`);
	await linuxUser.removeUser(config.username);
	module.eventEmitter.emit('users:updated');
	return `User ${config.username} deleted.`

	async function deleteAutheliaUser() {
		const fileContents = await fs.promises.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			delete autheliaUsersConfig.users[config.username];
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

const onConnection = (socket, module) => {
	socket.on('user:delete', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('user:delete', { config, username: socket.username });
	});
};

module.exports = {
	name: 'delete',
	onConnection,
	jobs: {
		'user:delete': deleteUser
	}
};
