const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini =  require('ini');

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
					cap: 0,
					isPrivate: (value['guest ok']?.toLowerCase() !== 'yes'),
					isTimeMachine: (value['fruit:time machine'] === 'yes')
				};
				state.shares.push(share);
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
