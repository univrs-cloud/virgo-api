const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();
const { Queue, Worker } = require('bullmq');
const cost = 12;

let nsp;
let state = {};
const autheliaUsersFile = '/messier/apps/authelia/config/users.yml';
const queue = new Queue('user-jobs');
const worker = new Worker(
	'user-jobs',
	async (job) => {
		if (job.name === 'createUser') {
			return await createUser(job);
		}
		if (job.name === 'updateUser') {
			return await updateUser(job);
		}
		if (job.name === 'deleteUser') {
			return await deleteUser(job);
		}
		if (job.name === 'updateProfile') {
			return await updateProfile(job);
		}
		if (job.name === 'changePassword') {
			return await changePassword(job);
		}
	},
	{
		connection: {
			host: 'localhost',
			port: 6379,
		}
	}
);
worker.on('completed', async (job, result) => {
	if (job) {
		await job.updateProgress({ state: await job.getState(), message: result });
	}
});
worker.on('failed', async (job, error) => {
	if (job) {
		await job.updateProgress({ state: await job.getState(), message: `` });
	}
});
worker.on('error', (error) => {
	console.error(error);
});

const getUsers = (socket) => {
	const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
	let autheliaUsersConfig = yaml.load(fileContents);
	return Promise.all(
		[
			linuxUser.getUsers(),
			linuxUser.getGroups()
		]
	)
		.then(([users, groups]) => {
			users = users.filter((user) => { return user.uid >= 1000 && user.uid <= 10000; });
			users = users.map((user) => {
				user.isOwner = (user.uid === 1000);
				user.groups = groups.filter((group) => { return group.gid === user.gid });
				if (autheliaUsersConfig.users && autheliaUsersConfig.users[user.username]) {
					user.email = autheliaUsersConfig.users[user.username].email;
				}
				return user;
			});
			state.users = users;
		})
		.catch((error) => {
			state.users = false;
		});
};

const createUser = async (job) => {
	let config = job.data.config;
	await job.updateProgress({ state: await job.getState(), message: `Creating system user ${config.username}...` });
	await linuxUser.addUser({
		username: config.username,
		create_home: false,
		shell: null
	});
	await job.updateProgress({ state: await job.getState(), message: `Creating SMB user ${config.username}...` });
	await setSambaUserPassword(config.username, config.password);
	await job.updateProgress({ state: await job.getState(), message: `Creating Authelia user ${config.username}...` });
	await createAutheliaUser(config.username, config);
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
	return `User ${config.username} created.`

	async function createAutheliaUser(username, config) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			updateAutheliaUserProfile(username, config);
		} else {
			autheliaUsersConfig.users[username] = {
				password: bcrypt.hashSync(config.password, cost),
				displayname: config.fullname,
				email: config.email,
				groups: ['user'],
				disabled: false
			};
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
};

const updateUser = async (job) => {
	let config = job.data.config;
	await job.updateProgress({ state: await job.getState(), message: `Updating system user ${config.username}...` });
	await exec(`chfn -f "${config.fullname}" ${config.username}`);
	await job.updateProgress({ state: await job.getState(), message: `Updating Authelia user ${config.username}...` });
	await updateAutheliaUserProfile(config.username, config);
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
	return `User ${config.username} updated.`
};

const deleteUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { user.username === config.username; });
	if (user.uid === 1000) {
		throw new Error('Owner cannot be deleted.');
	}

	await job.updateProgress({ state: await job.getState(), message: `Deleting system user ${config.username}...` });
	await linuxUser.removeUser(config.username);
	await job.updateProgress({ state: await job.getState(), message: `Deleting SMB user ${config.username}...` });
	await exec(`smbpasswd -s -x ${config.username}`);
	await job.updateProgress({ state: await job.getState(), message: `Deleting Authelia user ${config.username}...` });
	await deleteAutheliaUser(config.username);
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
	return `User ${config.username} deleted.`

	async function deleteAutheliaUser(username) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			delete autheliaUsersConfig.users[username];
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
};

const updateProfile = async (job) => {
	let config = job.data.config;
	await job.updateProgress({ state: await job.getState(), message: `Updating system user profile...` });
	await exec(`chfn -f "${config.fullname}" ${job.data.user}`);
	await job.updateProgress({ state: await job.getState(), message: `Changing Authelia user profile...` });
	await updateAutheliaUserProfile(job.data.user, config);
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
	return `Profile updated.`;
};

const changePassword = async (job) => {
	let config = job.data.config;
	await job.updateProgress({ state: await job.getState(), message: `Changing system user password...` });
	await linuxUser.setPassword(job.data.user, config.password);
	await job.updateProgress({ state: await job.getState(), message: `Changing SMB user password...` });
	await setSambaUserPassword(job.data.user, config.password);
	await job.updateProgress({ state: await job.getState(), message: `Changing Authelia user password...` });
	await setAutheliaUserPassword(job.data.user, config.password);
	return `Password changed.`;

	async function setAutheliaUserPassword(username, password) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].password = bcrypt.hashSync(password, cost);
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
};

const updateAutheliaUserProfile = async (username, config) => {
	const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
	let autheliaUsersConfig = yaml.load(fileContents);
	if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
		autheliaUsersConfig.users[username].displayname = config.fullname;
		autheliaUsersConfig.users[username].email = config.email;
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
	}
};

const setSambaUserPassword = async (username, password) => {
	return exec(`echo "${password}\n${password}" | smbpasswd -s -a "${username}"`)
		.then(() => {
		})
		.catch((error) => {
			console.log(error);
		});
};

module.exports = (io) => {
	nsp = io.of('/user');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		if (state.users) {
			if (socket.isAuthenticated) {
				nsp.to(`user:${socket.user}`).emit('users', state.users);
			}
		} else {
			getUsers()
				.then(() => {
					if (socket.isAuthenticated) {
						nsp.to(`user:${socket.user}`).emit('users', state.users);
					}		
				});
		}

		socket.on('create', (config) => {
			if (socket.isAuthenticated) {
				queue.add('createUser', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('update', (config) => {
			if (socket.isAuthenticated) {
				queue.add('updateUser', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('delete', (config) => {
			if (socket.isAuthenticated) {
				queue.add('deleteUser', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('profile', (config) => {
			if (socket.isAuthenticated) {
				queue.add('updateProfile', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('password', (config) => {
			if (socket.isAuthenticated) {
				queue.add('changePassword', { config, user: socket.user })
					.catch((error) => {
						console.error('Error starting job:', error);
					});
			}
		});

		socket.on('disconnect', () => {
			//
		});
	});
};
