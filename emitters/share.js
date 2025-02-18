const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;

let nsp;
let state = {};

const pollShares = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.shares;
		return;
	}

	state.shares = [];

	exec('testparm -s -l')
		.then((response) => {
			let shares = ini.parse(response.stdout);
			delete shares.global;
			for (let [name, value] of Object.entries(shares)) {
				let share = {
					name: name,
					comment: value['comment'],
					validUsers: value['valid users']?.split(' '),
					size: 0,
					free: 0,
					alloc: 0,
					cap: 0,
					isPrivate: (value['guest ok']?.toLowerCase() !== 'yes'),
					isTimeMachine: (value['fruit:time machine'] === 'yes')
				};
				return checkDiskSpace(value['path'])
					.then((diskSpace) => {
						share.size = diskSpace.size;
						share.free = diskSpace.free;
						share.alloc = share.size - share.free;
						share.cap = share.alloc / share.size * 100;
						state.shares.push(share);
					});
			}
		})
		.catch((error) => {
			state.shares = false;
		})
		.then(() => {
			nsp.emit('shares', state.shares);
			setTimeout(pollShares.bind(null, socket), 60000);
		});
};

module.exports = (io) => {
	nsp = io.of('/share');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.timeouts = {};
		socket.join(`user:${socket.user}`);

		if (state.shares) {
			nsp.emit('shares', state.shares);
		} else {
			pollShares(socket);
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
