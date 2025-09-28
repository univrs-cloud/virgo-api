const fs = require('fs');
const { execa } = require('execa');
const yaml = require('js-yaml');
const linuxUser = require('linux-sys-user').promise();
const BasePlugin = require('../base');

class UserPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'user');
	}

	init() {
		this.autheliaUsersFile = '/messier/apps/authelia/config/users.yml';
		this.cost = 12;
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

	async setSambaUserPassword(username, password) {
		try {
			const proc = execa('smbpasswd', ['-s', '-a', username]);
			proc.stdin.write(`${password}\n${password}\n`);
  			proc.stdin.end();
			await proc;
		} catch (error) {
			console.log(error);
		}
	}

	async toggleAutheliaUserLock(username, status) {
		const fileContents = await fs.promises.readFile(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].disabled = status;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.promises.writeFile(this.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}

	async emitUsers() {
		const getUsers = async () => {
			try {
				const fileContents = await fs.promises.readFile(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
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
