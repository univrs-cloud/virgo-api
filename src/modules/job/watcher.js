
const { Queue, QueueEvents } = require('bullmq');

module.exports = {
	name: 'watcher',
	register(module) {
        const eventsToListen = ['waiting', 'progress'];
		module.queues.forEach((queueName) => {
			const queue = new Queue(queueName);
			const queueEvents = new QueueEvents(queueName);
			eventsToListen.forEach((event) => {
				queueEvents.on(event, async (response) => {
					try {
						let job = await queue.getJob(response.jobId);
						if (job) {
							for (const socket of module.nsp.sockets.values()) {
								if (socket.isAuthenticated && socket.isAdmin) {
									module.nsp.to(`user:${socket.username}`).emit('job', job);
								}
							}
						}
					} catch (error) {
						console.error(`Error processing job ${response.jobId}:`, error);
					}
				});
			});
		});
	},
	async onConnection(socket, module) {
		const states = ['wait', 'paused', 'delayed', 'active'];
		let jobs = [];
		for (const queueName of module.queues) {
			const queue = new Queue(queueName);
			const queuedJobs = await queue.getJobs(states);	
			jobs = [...jobs, ...queuedJobs];
		};
		jobs = jobs.filter((job) => { return !job.opts || !job.opts.repeat; });
		socket.emit('jobs', jobs);
	}
};
