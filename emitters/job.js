const { Queue, QueueEvents } = require('bullmq');

const queue = new Queue('jobs');
let nsp;

const setupQueueEvents = () => {
	const queueEvents = new QueueEvents('jobs');
	queueEvents.on('waiting', (job) => {
		emitJob(job.jobId);
	});
	queueEvents.on('active', (job) => {
		emitJob(job.jobId);
	});
	queueEvents.on('progress', (job) => {
		emitJob(job.jobId);
	});
	queueEvents.on('completed', (job) => {
		emitJob(job.jobId);
	});
	queueEvents.on('failed', (job) => {
		emitJob(job.jobId);
	});
};

const emitJob = (jobId) => {
	queue.getJob(jobId)
		.then((job) => {
			if (job) {
				nsp.sockets.forEach((socket) => {
					if (socket.isAuthenticated) {
						nsp.to(`user:${socket.user}`).emit('job', job);
					}
				});
			}
		})
		.catch((error) => {
			console.error(`Error fetching job ${job.id}:`, error);
		});
};

const initialJobs = (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}

	queue.getJobs()
		.then((jobs) => {
			nsp.to(`user:${socket.user}`).emit('jobs', jobs);
		})
		.catch((error) => {
			console.error('Error fetching initial jobs:', error);
		});
};

module.exports = (io) => {
	nsp = io.of('/job');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);
		
		initialJobs(socket);

		socket.on('disconnect', () => {
			//
		});
	});
	setupQueueEvents();
};
