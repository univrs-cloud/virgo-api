
const { Queue, QueueEvents } = require('bullmq');

const queues = new Map();

const register = (module) => {
	const eventsToListen = ['waiting', 'progress'];
	module.queues.forEach((queueName) => {
		const queue = new Queue(queueName);
		queues.set(queueName, queue);
		const queueEvents = new QueueEvents(queueName);
		eventsToListen.forEach((event) => {
			queueEvents.on(event, async (response) => {
				try {
					let job = await queue.getJob(response.jobId);
					if (job) {
						for (const socket of module.nsp.sockets.values()) {
							if (socket.isAuthenticated && socket.isAdmin) {
								socket.emit('job', job);
							}
						}
					}
				} catch (error) {
					console.error(`Error processing job ${response.jobId}:`, error);
				}
			});
		});
	});
};

const onConnection = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	const states = ['wait', 'paused', 'delayed', 'active'];
	let jobs = [];
	for (const queueName of module.queues) {
		const queue = queues.get(queueName);
		const queuedJobs = await queue.getJobs(states);	
		jobs = [...jobs, ...queuedJobs];
	};
	jobs = jobs.filter((job) => { return !job.opts || !job.opts.repeat; });
	socket.emit('jobs', jobs);
};

module.exports = {
	name: 'watcher',
	register,
	onConnection
};
