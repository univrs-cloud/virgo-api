const fs = require('fs');
const { execa } = require('execa');
const yaml = require('js-yaml');

const updateUser = async (job, module) => {
	const config = job.data.config;
	const user = module.getState('users')?.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	const authenticatedUser = module.getState('users')?.find((user) => { return user.username === job.data.username; });
	if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
		throw new Error(`Only the owner can update his own profile.`);
	}

	await module.updateJobProgress(job, `Updating system user ${config.username}...`);
	await execa('chfn', ['-f', config.fullname, config.username]);
	await module.updateJobProgress(job, `Updating Authelia user ${config.username}...`);
	await updateAutheliaUser();
	module.eventEmitter.emit('users:updated');
	return `User ${config.username} updated.`

	async function updateAutheliaUser() {
		const fileContents = await fs.promises.readFile(module.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[config.username]) {
			autheliaUsersConfig.users[config.username].displayname = config.fullname;
			autheliaUsersConfig.users[config.username].email = config.email;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(module.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}
};

const onConnection = (socket, module) => {
	socket.on('user:update', async (config) => {
		if (!socket.isAuthenticated) {
			return;
		}

		if (!socket.isAdmin && socket.username !== config.username) {
			return;
		}
		
		await module.addJob('user:update', { config, username: socket.username });
	});
};

module.exports = {
	name: 'update',
	onConnection,
	jobs: {
		'user:update': updateUser
	}
};
