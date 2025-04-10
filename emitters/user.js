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

const updateProfile = async (job) => {
	let config = job.data.config;
	await job.updateProgress({ state: await job.getState(), message: `Updating system user profile...` });
	await exec(`chfn -f "${config.fullname}" ${job.data.user}`);
	await job.updateProgress({ state: await job.getState(), message: `Changing Authelia user password...` });
	await updateAutheliaUserProfile(job.data.user, config);
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
	return `Profile updated.`;

	async function updateAutheliaUserProfile(username, config) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].displayname = config.fullname;
			autheliaUsersConfig.users[username].email = config.email;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
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
	
	async function setSambaUserPassword(username, password) {
		return exec(`echo "${password}\n${password}" | smbpasswd -a -s "${username}"`)
			.then(() => {
			})
			.catch((error) => {
				console.log(error);
			});
	}

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
