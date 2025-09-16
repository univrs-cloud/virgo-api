const fs = require('fs');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const changePassword = async (job, plugin) => {
	let config = job.data.config;
	let user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	let authenticatedUser = plugin.getState('users').find((user) => { return user.username === job.data.username; });
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
		const fileContents = fs.readFileSync(plugin.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			autheliaUsersConfig.users[config.username].password = bcrypt.hashSync(config.password, plugin.cost);
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(plugin.autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
};

module.exports = {
	name: 'change_password',
	onConnection(socket, plugin) {
		socket.on('user:password', async (config) => {
			await plugin.handleUserAction(socket, 'user:changePassword', config);
		});
	},
	jobs: {
		'user:changePassword': changePassword
	}
};
