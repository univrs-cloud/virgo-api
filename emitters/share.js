let nsp;
let state = {};

module.exports = (io) => {
	state.shares = [
		{
			name: 'downloads',
			isPrivate: false,
			cap: 47
		},
		{
			name: 'time machine user 1',
			isPrivate: true,
			cap: 22
		},
		{
			name: 'time machine user 2',
			isPrivate: true,
			cap: 33
	
		}
	];

	nsp = io.of('/share').on('connection', (socket) => {
		if (state.shares) {
			nsp.emit('shares', state.shares);
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
