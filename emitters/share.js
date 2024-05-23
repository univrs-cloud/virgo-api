let nsp;
let state = {};

module.exports = (io) => {
	state.shares = [];

	nsp = io.of('/share').on('connection', (socket) => {
		if (state.shares) {
			nsp.emit('shares', state.shares);
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
