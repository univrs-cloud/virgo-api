
const { Queue, QueueEvents } = require('bullmq');

module.exports = {
	name: 'watcher',
	register(plugin) {
        const eventsToListen = ['waiting', 'progress'];
		plugin.queues.forEach((queueName) => {
			const queue = new Queue(queueName);
			const queueEvents = new QueueEvents(queueName);
			eventsToListen.forEach((event) => {
				queueEvents.on(event, async (response) => {
					try {
						let job = await queue.getJob(response.jobId);
						if (job) {
							for (const socket of plugin.getNsp().sockets.values()) {
								if (socket.isAuthenticated && socket.isAdmin) {
									plugin.getNsp().to(`user:${socket.username}`).emit('job', job);
								}
							}
						}
					} catch (error) {
						console.error(`Error processing job ${response.jobId}:`, error);
					}
				});
			});
		});
	}
};
