const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();
const BaseEmitter = require('./base');
const cost = 12;

class UserEmitter extends BaseEmitter {
	#autheliaUsersFile = '/messier/apps/authelia/config/users.yml';

	constructor(io) {
		super(io, 'user');
	}

	onConnection(socket) {
		const handleUserAction = async (socket, action, config) => {
			if (!socket.isAuthenticated) {
				return;
			}
		
			if (!socket.isAdmin && ['createUser', 'deleteUser', 'lockUser', 'unlockUser'].includes(action)) {
				return;
			}
		
			if (!socket.isAdmin && ['updateUser', 'changePassword'].includes(action) && socket.username !== config.username) {
				return;
			}
			
			await this.addJob(action, { config, username: socket.username });
		};

		if (this.getState('users')) {
			if (socket.isAuthenticated) {
				if (!socket.isAdmin) {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users').filter((user) => { return user.username === socket.username; }));
				} else {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users'));
				}
			}
		} else {
			this.#emitUsers();
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
	}

	async processJob(job) {
		if (job.name === 'createUser') {
			return await this.#createUser(job);
		}
		if (job.name === 'updateUser') {
			return await this.#updateUser(job);
		}
		if (job.name === 'deleteUser') {
			return await this.#deleteUser(job);
		}
		if (job.name === 'lockUser') {
			return await this.#lockUser(job);
		}
		if (job.name === 'unlockUser') {
			return await this.#unlockUser(job);
		}
		if (job.name === 'changePassword') {
			return await this.#changePassword(job);
		}
	}

	async #createUser(job) {
		const createAutheliaUser = async (username, config) => {
			const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
			let autheliaUsersConfig = yaml.load(fileContents);
			if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
				this.#updateAutheliaUser(username, config);
			} else {
				autheliaUsersConfig.users[username] = {
					password: bcrypt.hashSync(config.password, cost),
					displayname: config.fullname,
					email: config.email,
					groups: ['users'],
					disabled: false
				};
				const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
				fs.writeFileSync(this.#autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
			}
		}

		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (user) {
			throw new Error(`User already exists.`);
		}
	
		await this.updateJobProgress(job, `Creating system user ${config.username}...`);
		await linuxUser.addUser({
			username: config.username,
			create_home: false,
			shell: null
		});
		await linuxUser.setPassword(config.username, config.password);
		await exec(`chfn -f "${config.fullname}" ${config.username}`);
		await this.updateJobProgress(job, `Creating SMB user ${config.username}...`);
		await this.#setSambaUserPassword(config.username, config.password);
		await this.updateJobProgress(job, `Creating Authelia user ${config.username}...`);
		await createAutheliaUser(config.username, config);
		await this.#emitUsers();
		return `User ${config.username} created.`
	}
	
	async #updateUser(job) {
		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (!user) {
			throw new Error(`User ${config.username} not found.`);
		}
	
		let authenticatedUser = this.getState('users').find((user) => { return user.username === job.data.username; });
		if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
			throw new Error(`Only the owner can update his own profile.`);
		}
	
		await this.updateJobProgress(job, `Updating system user ${config.username}...`);
		await exec(`chfn -f "${config.fullname}" ${config.username}`);
		await this.updateJobProgress(job, `Updating Authelia user ${config.username}...`);
		await this.#updateAutheliaUser(config.username, config);
		await this.#emitUsers();
		return `User ${config.username} updated.`
	}
	
	async #deleteUser(job) {
		const deleteAutheliaUser = async (username) => {
			const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
			let autheliaUsersConfig = yaml.load(fileContents);
			if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
				delete autheliaUsersConfig.users[username];
				const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
				fs.writeFileSync(this.#autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
			}
		}

		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (!user) {
			throw new Error(`User ${config.username} not found.`);
		}
	
		if (user.uid === 1000) {
			throw new Error(`Owner cannot be deleted.`);
		}
	
		await this.updateJobProgress(job, `Deleting Authelia user ${config.username}...`);
		await deleteAutheliaUser(config.username);
		await this.updateJobProgress(job, `Deleting SMB user ${config.username}...`);
		await exec(`smbpasswd -s -x ${config.username}`);
		await this.updateJobProgress(job, `Deleting system user ${config.username}...`);
		await linuxUser.removeUser(config.username);
		await this.#emitUsers();
		return `User ${config.username} deleted.`
	}
	
	async #lockUser(job) {
		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (!user) {
			throw new Error(`User ${config.username} not found.`);
		}
	
		if (user.uid === 1000) {
			throw new Error(`Owner cannot be locked.`);
		}
	
		await this.updateJobProgress(job, `Locking system user ${config.username}...`);
		await exec(`passwd -l ${config.username}`);
		await this.updateJobProgress(job, `Locking Samba user ${config.username}...`);
		await exec(`smbpasswd -d ${config.username}`);
		await this.updateJobProgress(job, `Locking Authelia user ${config.username}...`);
		await this.#toggleAutheliaUserLock(config.username, true);
		await this.#emitUsers();
		return `${config.username} locked.`;
	}
	
	async #unlockUser(job) {
		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (!user) {
			throw new Error(`User ${config.username} not found.`);
		}
	
		await this.updateJobProgress(job, `Unlocking system user ${config.username}...`);
		await exec(`passwd -u ${config.username}`);
		await this.updateJobProgress(job, `Unlocking Samba user ${config.username}...`);
		await exec(`smbpasswd -e ${config.username}`);
		await this.updateJobProgress(job, `Unlocking Authelia user ${config.username}...`);
		await this.#toggleAutheliaUserLock(config.username, false);
		await this.#emitUsers();
		return `${config.username} unlocked.`;
	}
	
	async #changePassword(job) {
		const setAutheliaUserPassword = async (username, password) => {
			const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
			let autheliaUsersConfig = yaml.load(fileContents);
			if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
				autheliaUsersConfig.users[username].password = bcrypt.hashSync(password, cost);
				const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
				fs.writeFileSync(this.#autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
			}
		}
		
		let config = job.data.config;
		let user = this.getState('users').find((user) => { return user.username === config.username; });
		if (!user) {
			throw new Error(`User ${config.username} not found.`);
		}
	
		let authenticatedUser = this.getState('users').find((user) => { return user.username === job.data.username; });
		if (authenticatedUser.uid !== user.uid && user.uid === 1000) {
			throw new Error(`Only the owner can change his own password.`);
		}
	
		await this.updateJobProgress(job, `Changing system user password for ${config.username}...`);
		await linuxUser.setPassword(config.username, config.password);
		await this.updateJobProgress(job, `Changing SMB user password for ${config.username}...`);
		await this.#setSambaUserPassword(config.username, config.password);
		await this.updateJobProgress(job, `Changing Authelia user password for ${config.username}...`);
		await setAutheliaUserPassword(config.username, config.password);
		return `${config.username} password changed.`;
	}
	
	async #updateAutheliaUser(username, config) {
		const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].displayname = config.fullname;
			autheliaUsersConfig.users[username].email = config.email;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(this.#autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
	
	async #toggleAutheliaUserLock(username, status) {
		const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].disabled = status;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(this.#autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}
	
	async #setSambaUserPassword(username, password) {
		try {
			await exec(`echo "${password}\n${password}" | smbpasswd -s -a "${username}"`);
		} catch (error) {
			console.log(error);
		}
	}

	async #emitUsers() {
		const getUsers = async () => {
			try {
				const fileContents = fs.readFileSync(this.#autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
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
				this.setState('users', users);
			} catch (error) {
				this.setState('users', false);
			}
		}

		await getUsers();
		this.getNsp().sockets.forEach((socket) => {
			if (socket.isAuthenticated) {
				if (!socket.isAdmin) {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users').filter((user) => { return user.username === socket.username; }));
				} else {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users'));
				}
			}
		});
	}	
}

module.exports = (io) => {
	return new UserEmitter(io);
};
