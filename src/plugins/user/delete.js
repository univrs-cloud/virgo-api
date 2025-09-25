const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const linuxUser = require('linux-sys-user').promise();

const deleteUser = async (job, plugin) => {
	let config = job.data.config;
	let user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be deleted.`);
	}

	await plugin.updateJobProgress(job, `Deleting Authelia user ${config.username}...`);
	await deleteAutheliaUser();
	await plugin.updateJobProgress(job, `Deleting SMB user ${config.username}...`);
	await exec(`smbpasswd -s -x ${config.username}`);
	await plugin.updateJobProgress(job, `Deleting system user ${config.username}...`);
	await linuxUser.removeUser(config.username);
	await plugin.emitUsers();
	return `User ${config.username} deleted.`

	async function deleteAutheliaUser() {
		const fileContents = await fs.promises.readFile(plugin.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			delete autheliaUsersConfig.users[config.username];
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(plugin.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

module.exports = {
	name: 'delete',
	onConnection(socket, plugin) {
		socket.on('user:delete', async (config) => {
			await plugin.handleUserAction(socket, 'user:delete', config);
		});
	},
	jobs: {
		'user:delete': deleteUser
	}
};
