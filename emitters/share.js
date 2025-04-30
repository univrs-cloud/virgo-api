const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;

let nsp;
let state = {
	shares: []
};

const pollShares = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		return;
	}

	try {
		const response = await exec('testparm -s -l');
		const shares = ini.parse(response.stdout);
		delete shares.global;
		let promises = Object.entries(shares).map(async ([name, value]) => {
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

			try {
				const diskSpace = await checkDiskSpace(value['path']);
				share.size = diskSpace.size;
				share.free = diskSpace.free;
				share.alloc = share.size - share.free;
				share.cap = share.alloc / share.size * 100;
			  } catch (error) {
				console.error(`Error checking disk space for ${name}:`, error);
			  }
			  return share;
		});
		state.shares = await Promise.all(promises);
	} catch (error) {
		state.shares = false;
	} finally {
		nsp.emit('shares', state.shares);
		setTimeout(() => pollShares(socket), 60000);
	}
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
