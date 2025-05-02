const { Queue, QueueEvents } = require('bullmq');

const queues = ['configuration-jobs', 'docker-jobs', 'user-jobs', 'share-jobs'];
let nsp;

queues.forEach((queueName) => {
	const queue = new Queue(queueName);
	const queueEvents = new QueueEvents(queueName);
	queueEvents.on('progress', async (response) => {
		try {
			let job = await queue.getJob(response.jobId);
			if (job) {
				for (const socket of nsp.sockets.values()) {
					if (socket.isAuthenticated) {
						nsp.to(`user:${socket.user}`).emit('job', job);
					}
				};
			}
		} catch (error) {
			console.error(`Error processing job ${response.jobId}:`, error);
		}
	});
});

module.exports = (io) => {
	nsp = io.of('/job');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		socket.on('disconnect', () => {
			//
		});
	});
};
