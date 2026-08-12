import fs from 'fs/promises';
import * as yaml from 'js-yaml';
import bcrypt from 'bcryptjs';
import linuxSysUser from 'linux-sys-user';
import * as setup from '../../utils/setup_state.js';

const linuxUser = linuxSysUser.promise();
const changePassword = async (job, module) => {
	const { config } = job.data;
	const user = module.toArray(module.getState('users')).find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	// First-run setup acts as no account at all, so there is no owner to compare against — changing
	// the default user's password is the whole point of that step. Everywhere else the owner's
	// password stays the owner's to change.
	if (setup.isCompleted()) {
		const authenticatedUser = module.toArray(module.getState('users')).find((user) => { return user.username === job.data.username; });
		if (!authenticatedUser) {
			throw new Error(`User ${job.data.username} not found.`);
		}

		if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
			throw new Error(`Only the owner can change his own password.`);
		}
	}

	await module.updateJobProgress(job, `Changing system user password for ${config.username}...`);
	await linuxUser.setPassword(config.username, config.password);
	await module.updateJobProgress(job, `Changing SMB user password for ${config.username}...`);
	await module.setSambaUserPassword(config.username, config.password);
	await module.updateJobProgress(job, `Changing Authelia user password for ${config.username}...`);
	await setAutheliaUserPassword();
	return `${config.username} password changed.`;

	async function setAutheliaUserPassword() {
		const fileContents = await fs.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			autheliaUsersConfig.users[config.username].password = bcrypt.hashSync(config.password, module.cost);
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

const onConnection = (socket, module) => {
	socket.on('user:password', async (config) => {
		if (!socket.isAuthenticated) {
			return;
		}

		if (!socket.isAdmin && socket.username !== config.username) {
			return;
		}
		
		await module.addJob('user:changePassword', { config, username: socket.username });
	});
};

export default {
	name: 'change_password',
	onConnection,
	jobs: {
		'user:changePassword': changePassword
	}
};
