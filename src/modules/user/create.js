const fs = require('fs');
const { execa } = require('execa');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();

const createUser = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users')?.find((user) => { return user.username === config.username; });
	if (user) {
		throw new Error(`User already exists.`);
	}

	await module.updateJobProgress(job, `Creating system user ${config.username}...`);
	await linuxUser.addUser({
		username: config.username,
		create_home: false,
		shell: null
	});
	await linuxUser.setPassword(config.username, config.password);
	await execa('chfn', ['-f', config.fullname, config.username]);
	await module.updateJobProgress(job, `Creating SMB user ${config.username}...`);
	await module.setSambaUserPassword(config.username, config.password);
	await module.updateJobProgress(job, `Creating Authelia user ${config.username}...`);
	await createAutheliaUser();
	module.eventEmitter.emit('users:updated');
	return `User ${config.username} created.`

	async function createAutheliaUser () {
		const fileContents = await fs.promises.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (!autheliaUsersConfig.users) {
			autheliaUsersConfig.users = {};
		}
		autheliaUsersConfig.users[config.username] = {
			password: bcrypt.hashSync(config.password, module.cost),
			displayname: config.fullname,
			email: config.email,
			groups: ['users'],
			disabled: false
		};
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		await fs.promises.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
	};
};

const onConnection = (socket, module) => {
	socket.on('user:create', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('user:create', { config, username: socket.username });
	});
};

module.exports = {
	name: 'create',
	onConnection,
	jobs: {
		'user:create': createUser
	}
};
