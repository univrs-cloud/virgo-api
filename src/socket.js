const { Server } = require('socket.io');

let io = null;

function initializeSocket(server) {
  if (io) {
    throw new Error('Socket.IO already initialized');
  }
  
  io = new Server(server);
  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocket first.');
  }
  return io;
}

module.exports = {
	initializeSocket,
	getIO
};
