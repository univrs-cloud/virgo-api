const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const linuxUser = require('linux-sys-user').promise();
const cost = 12;

let nsp;
let state = {};
const autheliaUsersFile = '/messier/apps/authelia/config/users.yml';

const getUsers = (socket) => {
	Promise.all(
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
				return user;
			});
			state.users = users;
		})
		.catch((error) => {
			state.users = false;
		})
		.then(() => {
			if (socket.isAuthenticated) {
				nsp.to(`user:${socket.user}`).emit('users', state.users);
			}
		});
};

const updateProfile = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	getUsers(socket);
};

const changePassword = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	setLinuxUserPassword(socket.user, config.password);
	setSambaUserPassword(socket.user, config.password);
	setAutheliaUserPassword(socket.user, config.password);
	
	function setLinuxUserPassword(username, password) {
		linuxUser.setPassword(socket.user, config.password)
			.then(() => {
			})
			.catch((error) => {
				console.log(error);
			});
	}

	function setSambaUserPassword(username, password) {
		exec(`echo "${password}\n${password}" | smbpasswd -a -s "${username}"`)
			.then(() => {
			})
			.catch((error) => {
				console.log(error);
			});
	}

	function setAutheliaUserPassword(username, password) {
		const fileContents = fs.readFileSync(autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let usersConfig = yaml.load(fileContents);
		if (usersConfig.users && usersConfig.users[username]) {
			usersConfig.users[username].password = bcrypt.hashSync(password, cost);
			const updatedYaml = yaml.dump(usersConfig, { indent: 2 });
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
			getUsers(socket);
		}

		socket.on('profile', (config) => { updateProfile(socket, config); });
		socket.on('password', (config) => { changePassword(socket, config); });

		socket.on('disconnect', () => {
			//
		});
	});
};
