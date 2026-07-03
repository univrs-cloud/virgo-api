import fs from 'fs/promises';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import bcrypt from 'bcryptjs';
import linuxSysUser from 'linux-sys-user';

const linuxUser = linuxSysUser.promise();
const createUser = async (job, module) => {
	const { config } = job.data;
	const user = module.toArray(module.getState('users')).find((user) => { return user.username === config.username; });
	if (user) {
		throw new Error(`User already exists.`);
	}

	const authenticatedUser = module.toArray(module.getState('users')).find((user) => { return user.username === job.data.username; });
	if (authenticatedUser?.uid !== 1000 && config.role === 'admin') {
		config.role = '';
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
		const fileContents = await fs.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (!autheliaUsersConfig.users) {
			autheliaUsersConfig.users = {};
		}
		autheliaUsersConfig.users[config.username] = {
			password: bcrypt.hashSync(config.password, module.cost),
			displayname: config.fullname,
			email: config.email,
			groups: (config.role === 'admin' ? ['admins'] : ['users']),
			disabled: false
		};
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		await fs.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
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

export default {
	name: 'create',
	onConnection,
	jobs: {
		'user:create': createUser
	}
};
