const fs = require('fs');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const changePassword = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	const authenticatedUser = module.getState('users').find((user) => { return user.username === job.data.username; });
	if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
		throw new Error(`Only the owner can change his own password.`);
	}

	await module.updateJobProgress(job, `Changing system user password for ${config.username}...`);
	await linuxUser.setPassword(config.username, config.password);
	await module.updateJobProgress(job, `Changing SMB user password for ${config.username}...`);
	await module.setSambaUserPassword(config.username, config.password);
	await module.updateJobProgress(job, `Changing Authelia user password for ${config.username}...`);
	await setAutheliaUserPassword();
	return `${config.username} password changed.`;

	async function setAutheliaUserPassword() {
		const fileContents = await fs.promises.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			autheliaUsersConfig.users[config.username].password = bcrypt.hashSync(config.password, module.cost);
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

module.exports = {
	name: 'change_password',
	onConnection(socket, module) {
		socket.on('user:password', async (config) => {
			if (!socket.isAuthenticated) {
				return;
			}

			if (!socket.isAdmin && socket.username !== config.username) {
				return;
			}
			
			await module.addJob('user:changePassword', { config, username: socket.username });
		});
	},
	jobs: {
		'user:changePassword': changePassword
	}
};
