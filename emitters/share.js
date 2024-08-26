const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini =  require('ini');

let nsp;
let state = {};

const pollShares = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.shares;
		return;
	}

	exec('testparm -s -l')
		.then((response) => {
			let shares = ini.parse(response.stdout);
			delete shares.global;
			state.shares = [];
			for (let [name, value] of Object.entries(shares)) {
				let share = {
					name: name,
					isPrivate: value['guest ok']?.toLowerCase() !== 'yes',
					cap: 100
				};
				state.shares.push(share);
			}
		})
		.catch((error) => {
			console.log(error);
			state.shares = false;
		})
		.then(() => {
			nsp.emit('shares', state.shares);
			setTimeout(pollShares, 60000);
		});
};

module.exports = (io) => {
	nsp = io.of('/share').on('connection', (socket) => {
		if (state.shares) {
			nsp.emit('shares', state.shares);
		} else {
			pollShares();
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
