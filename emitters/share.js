let io;
let state = {};

const setIo = (value) => {
	io = value;
};

module.exports = (io) => {
	setIo(io);

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

	io.on('connection', (socket) => {
		if (state.shares) {
			io.emit('shares', state.shares);
		}

		socket.on('disconnect', () => {
			//
		});
	});
};
