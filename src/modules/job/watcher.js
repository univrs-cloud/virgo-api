
import { Queue, QueueEvents } from 'bullmq';

const queues = new Map();
const PENDING_STATES = ['wait', 'paused', 'prioritized', 'delayed', 'active'];

const listPendingJobs = async (module) => {
	let jobs = [];
	for (const queueName of module.queues) {
		const queue = queues.get(queueName);
		const queuedJobs = await queue.getJobs(PENDING_STATES);
		jobs = [...jobs, ...queuedJobs];
	};
	return jobs.filter((job) => { return !job.opts || !job.opts.repeat; });
};

const isAppUpdateJob = (job) => {
	return job?.name === 'app:update' && !!job.data?.config?.name;
};

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
						if (isAppUpdateJob(job)) {
							module.eventEmitter.emit('app:update:job:updated', job);
						}
					}
				} catch (error) {
					console.error(`Error processing job ${response.jobId}:`, error);
				}
			});
		});
	});

	// A consumer that has to drop what it knew (the fleet clears a node's state when it disconnects) asks
	// for the in-flight app updates again — the same catch-up a browser gets from onConnection.
	module.eventEmitter.on('app:update:jobs:sync', async () => {
		try {
			for (const job of (await listPendingJobs(module)).filter(isAppUpdateJob)) {
				module.eventEmitter.emit('app:update:job:updated', job);
			}
		} catch (error) {
			console.error('Error listing app update jobs:', error);
		}
	});
};

const onConnection = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	socket.emit('jobs', await listPendingJobs(module));
};

export default {
	name: 'watcher',
	register,
	onConnection
};
