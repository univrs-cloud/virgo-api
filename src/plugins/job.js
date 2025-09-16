const { Queue, QueueEvents } = require('bullmq');
const BasePlugin = require('./base');

class JobPlugin extends BasePlugin {
	#queues = ['configuration-jobs', 'host-jobs', 'docker-jobs', 'user-jobs', 'share-jobs'];

	constructor(io) {
		super(io, 'job');
		this.#watchQueues();
	}

	#watchQueues() {
		const eventsToListen = ['waiting', 'progress'];
		this.#queues.forEach((queueName) => {
			const queue = new Queue(queueName);
			const queueEvents = new QueueEvents(queueName);
			eventsToListen.forEach((event) => {
				queueEvents.on(event, async (response) => {
					try {
						let job = await queue.getJob(response.jobId);
						if (job) {
							for (const socket of this.getNsp().sockets.values()) {
								if (socket.isAuthenticated && socket.isAdmin) {
									this.getNsp().to(`user:${socket.username}`).emit('job', job);
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
}

module.exports = (io) => {
	return new JobPlugin(io);
};
