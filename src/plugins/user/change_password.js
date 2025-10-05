const fs = require('fs');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const changePassword = async (job, plugin) => {
	const config = job.data.config;
	const user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	const authenticatedUser = plugin.getState('users').find((user) => { return user.username === job.data.username; });
	if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
		throw new Error(`Only the owner can change his own password.`);
	}

	await plugin.updateJobProgress(job, `Changing system user password for ${config.username}...`);
	await linuxUser.setPassword(config.username, config.password);
	await plugin.updateJobProgress(job, `Changing SMB user password for ${config.username}...`);
	await plugin.setSambaUserPassword(config.username, config.password);
	await plugin.updateJobProgress(job, `Changing Authelia user password for ${config.username}...`);
	await setAutheliaUserPassword();
	return `${config.username} password changed.`;

	async function setAutheliaUserPassword() {
		const fileContents = await fs.promises.readFile(plugin.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			autheliaUsersConfig.users[config.username].password = bcrypt.hashSync(config.password, plugin.cost);
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(plugin.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

module.exports = {
	name: 'change_password',
	onConnection(socket, plugin) {
		socket.on('user:password', async (config) => {
			if (!socket.isAuthenticated) {
				return;
			}

			if (!socket.isAdmin && socket.username !== config.username) {
				return;
			}
			
			await plugin.addJob('user:changePassword', { config, username: socket.username });
		});
	},
	jobs: {
		'user:changePassword': changePassword
	}
};
