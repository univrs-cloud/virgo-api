const fs = require('fs');
const { execa } = require('execa');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const createUser = async (job, plugin) => {
	const config = job.data.config;
	const user = plugin.getState('users').find((user) => { return user.username === config.username; });
	if (user) {
		throw new Error(`User already exists.`);
	}

	await plugin.updateJobProgress(job, `Creating system user ${config.username}...`);
	await linuxUser.addUser({
		username: config.username,
		create_home: false,
		shell: null
	});
	await linuxUser.setPassword(config.username, config.password);
	await execa('chfn', ['-f', config.fullname, config.username]);
	await plugin.updateJobProgress(job, `Creating SMB user ${config.username}...`);
	await plugin.setSambaUserPassword(config.username, config.password);
	await plugin.updateJobProgress(job, `Creating Authelia user ${config.username}...`);
	await createAutheliaUser();
	await plugin.emitUsers();
	return `User ${config.username} created.`

	async function createAutheliaUser () {
		const fileContents = await fs.promises.readFile(plugin.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (!autheliaUsersConfig.users) {
			autheliaUsersConfig.users = {};
		}
		autheliaUsersConfig.users[config.username] = {
			password: bcrypt.hashSync(config.password, plugin.cost),
			displayname: config.fullname,
			email: config.email,
			groups: ['users'],
			disabled: false
		};
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		await fs.promises.writeFile(plugin.autheliaUsersFile, updatedYaml, 'utf8');
	};
};

module.exports = {
	name: 'create',
	onConnection(socket, plugin) {
		socket.on('user:create', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await plugin.addJob('user:create', { config, username: socket.username });
		});
	},
	jobs: {
		'user:create': createUser
	}
};
