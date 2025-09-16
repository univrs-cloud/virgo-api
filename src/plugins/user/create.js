const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const createUser = async (job, plugin) => {
	let config = job.data.config;
	let user = plugin.getState('users').find((user) => { return user.username === config.username; });
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
	await exec(`chfn -f "${config.fullname}" ${config.username}`);
	await plugin.updateJobProgress(job, `Creating SMB user ${config.username}...`);
	await plugin.setSambaUserPassword(config.username, config.password);
	await plugin.updateJobProgress(job, `Creating Authelia user ${config.username}...`);
	await createAutheliaUser();
	await plugin.emitUsers();
	return `User ${config.username} created.`

	async function createAutheliaUser () {
		const fileContents = fs.readFileSync(plugin.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
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
		fs.writeFileSync(plugin.autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
	};
};

module.exports = {
	name: 'create',
	onConnection(socket, plugin) {
		socket.on('user:create', async (config) => {
			await plugin.handleUserAction(socket, 'user:create', config);
		});
	},
	jobs: {
		'user:create': createUser
	}
};
