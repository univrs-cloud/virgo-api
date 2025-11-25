const { Server } = require('socket.io');

let io = null;

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}
	
	io = new Server(server, {
		path: '/api'
	});

	io.engine.on("connection", (rawSocket) => {
		rawSocket.request = null;
	});	  

	return io;
};

const getIO = () => {
	if (!io) {
		throw new Error('Socket.IO not initialized. Call initializeSocket first.');
	}
	return io;
};

module.exports = {
	initializeSocket,
	getIO
};
