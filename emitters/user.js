const linuxUser = require('linux-sys-user').promise();

let nsp;
let state = {};

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
	});

module.exports = (io) => {
	nsp = io.of('/user');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		if (socket.isAuthenticated) {
			nsp.to(`user:${socket.user}`).emit('users', state.users);
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
