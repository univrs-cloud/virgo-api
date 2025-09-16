const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();
const BasePlugin = require('../base');

class UserPlugin extends BasePlugin {
	autheliaUsersFile = '/messier/apps/authelia/config/users.yml';
	cost = 12;

	constructor(io) {
		super(io, 'user');
	}

	onConnection(socket) {
		if (this.getState('users')) {
			if (socket.isAuthenticated) {
				if (!socket.isAdmin) {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users').filter((user) => { return user.username === socket.username; }));
				} else {
					this.getNsp().to(`user:${socket.username}`).emit('users', this.getState('users'));
				}
			}
		} else {
			this.emitUsers();
		}
	}

	async handleUserAction(socket, action, config) {
		if (!socket.isAuthenticated) {
			return;
		}
	
		if (!socket.isAdmin && ['user:create', 'user:delete', 'user:lock', 'user:unlock'].includes(action)) {
			return;
		}
	
		if (!socket.isAdmin && ['user:update', 'user:changePassword'].includes(action) && socket.username !== config.username) {
			return;
		}
		
		await this.addJob(action, { config, username: socket.username });
	}

	async setSambaUserPassword(username, password) {
		try {
			await exec(`echo "${password}\n${password}" | smbpasswd -s -a "${username}"`);
		} catch (error) {
			console.log(error);
		}
	}

	async toggleAutheliaUserLock(username, status) {
		const fileContents = fs.readFileSync(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].disabled = status;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			fs.writeFileSync(this.autheliaUsersFile, updatedYaml, 'utf8', { flag: 'w' });
		}
	}

	async emitUsers() {
		const getUsers = async () => {
			try {
				const fileContents = fs.readFileSync(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
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
	return new UserPlugin(io);
};
