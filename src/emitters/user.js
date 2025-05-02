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
		if (job.name === 'lockUser') {
			return await lockUser(job);
		}
		if (job.name === 'unlockUser') {
			return await unlockUser(job);
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
		await updateProgress(job, result);
	}
});
worker.on('failed', async (job, error) => {
	if (job) {
		await updateProgress(job, ``);
	}
});
worker.on('error', (error) => {
	console.error(error);
});

const updateProgress = async (job, message) => {
	const state = await job.getState();
	await job.updateProgress({ state, message });
};

const getUsers = async () => {
	try {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		let users = await linuxUser.getUsers();
		let groups = await linuxUser.getGroups();
		users = users
			.filter((user) => {
				return user.uid >= 1000 && user.uid <= 10000;
			})
			.map((user) => {
				user.isOwner = (user.uid === 1000);
				user.isDisabled = false;
				user.groups = groups.filter((group) => { return group.gid === user.gid });
				user.email = null;
				if (autheliaUsersConfig.users && autheliaUsersConfig.users[user.username]) {
					user.isDisabled = autheliaUsersConfig.users[user.username].disabled;
					user.groups = [...user.groups, ...autheliaUsersConfig.users[user.username].groups];
					user.email = autheliaUsersConfig.users[user.username].email;
				}
				return user;
			});
		state.users = users;
	} catch (error) {
		state.users = false;
	}
};

const createUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (user) {
		throw new Error(`User already exists.`);
	}

	await updateProgress(job, `Creating system user ${config.username}...`);
	await linuxUser.addUser({
		username: config.username,
		create_home: false,
		shell: null
	});
	await linuxUser.setPassword(config.username, config.password);
	await exec(`chfn -f "${config.fullname}" ${config.username}`);
	await updateProgress(job, `Creating SMB user ${config.username}...`);
	await setSambaUserPassword(config.username, config.password);
	await updateProgress(job, `Creating Authelia user ${config.username}...`);
	await createAutheliaUser(config.username, config);
	await emitUsers();
	return `User ${config.username} created.`

	async function createAutheliaUser(username, config) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			updateAutheliaUser(username, config);
		} else {
			autheliaUsersConfig.users[username] = {
				password: bcrypt.hashSync(config.password, cost),
				displayname: config.fullname,
				email: config.email,
				groups: ['users'],
				disabled: false
			};
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
};

const updateUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	let authenticatedUser = state.users.find((user) => { return user.username === job.data.user; });
	if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
		throw new Error(`Only the owner can update his own profile.`);
	}

	await updateProgress(job, `Updating system user ${config.username}...`);
	await exec(`chfn -f "${config.fullname}" ${config.username}`);
	await updateProgress(job, `Updating Authelia user ${config.username}...`);
	await updateAutheliaUser(config.username, config);
	await emitUsers();
	return `User ${config.username} updated.`
};

const deleteUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be deleted.`);
	}

	await updateProgress(job, `Deleting Authelia user ${config.username}...`);
	await deleteAutheliaUser(config.username);
	await updateProgress(job, `Deleting SMB user ${config.username}...`);
	await exec(`smbpasswd -s -x ${config.username}`);
	await updateProgress(job, `Deleting system user ${config.username}...`);
	await linuxUser.removeUser(config.username);
	await emitUsers();
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

const lockUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	if (user.uid === 1000) {
		throw new Error(`Owner cannot be locked.`);
	}

	await updateProgress(job, `Locking system user ${config.username}...`);
	await exec(`passwd -l ${config.username}`);
	await updateProgress(job, `Locking Samba user ${config.username}...`);
	await exec(`smbpasswd -d ${config.username}`);
	await updateProgress(job, `Locking Authelia user ${config.username}...`);
	await toggleAutheliaUserLock(config.username, true);
	await emitUsers();
	return `${config.username} locked.`;
};

const unlockUser = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	await updateProgress(job, `Unlocking system user ${config.username}...`);
	await exec(`passwd -u ${config.username}`);
	await updateProgress(job, `Unlocking Samba user ${config.username}...`);
	await exec(`smbpasswd -e ${config.username}`);
	await updateProgress(job, `Unlocking Authelia user ${config.username}...`);
	await toggleAutheliaUserLock(config.username, false);
	await emitUsers();
	return `${config.username} unlocked.`;
};

const changePassword = async (job) => {
	let config = job.data.config;
	let user = state.users.find((user) => { return user.username === config.username; });
	if (!user) {
		throw new Error(`User ${config.username} not found.`);
	}

	let authenticatedUser = state.users.find((user) => { return user.username === job.data.user; });
	if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
		throw new Error(`Only the owner can change his own password.`);
	}

	await updateProgress(job, `Changing system user password for ${config.username}...`);
	await linuxUser.setPassword(config.username, config.password);
	await updateProgress(job, `Changing SMB user password for ${config.username}...`);
	await setSambaUserPassword(config.username, config.password);
	await updateProgress(job, `Changing Authelia user password for ${config.username}...`);
	await setAutheliaUserPassword(config.username, config.password);
	return `${config.username} password changed.`;

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

const updateAutheliaUser = async (username, config) => {
	const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
	let autheliaUsersConfig = yaml.load(fileContents);
	if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
		autheliaUsersConfig.users[username].displayname = config.fullname;
		autheliaUsersConfig.users[username].email = config.email;
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
	}
};

const toggleAutheliaUserLock = async (username, status) => {
	const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
	let autheliaUsersConfig = yaml.load(fileContents);
	if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
		autheliaUsersConfig.users[username].disabled = status;
		const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
		fs.writeFileSync(autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
	}
}

const setSambaUserPassword = async (username, password) => {
	try {
		await exec(`echo "${password}\n${password}" | smbpasswd -s -a "${username}"`);
	} catch (error) {
		console.log(error);
	}
};

const emitUsers = async () => {
	await getUsers();
	nsp.sockets.forEach((socket) => {
		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}
	});
};

const handleUserAction = async (socket, action, config) => {
	if (socket.isAuthenticated) {
		try {
			await queue.add(action, { config, user: socket.user });
		} catch (error) {
			console.error(`Error starting job:`, error);
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
			emitUsers();
		}

		socket.on('create', async (config) => {
			await handleUserAction(socket, 'createUser', config);
		});

		socket.on('update', async (config) => {
			await handleUserAction(socket, 'updateUser', config);
		});

		socket.on('delete', async (config) => {
			await handleUserAction(socket, 'deleteUser', config);
		});

		socket.on('lock', async (config) => {
			await handleUserAction(socket, 'lockUser', config);
		});

		socket.on('unlock', async (config) => {
			await handleUserAction(socket, 'unlockUser', config);
		});

		socket.on('password', async (config) => {
			await handleUserAction(socket, 'changePassword', config);
		});

		socket.on('disconnect', () => {
			//
		});
	});
};
