import { Queue } from 'bullmq';
import config from '../config.js';

const MODULES = [
	'job',
	'configuration',
	'host',
	'user',
	'docker',
	'bookmark',
	'share',
	'indexer',
	'weather'
];

const getQueueName = (moduleName) => `${moduleName}-jobs`;

/** Cron / repeatable jobs only (`addJobSchedule`). Regular `addJob` stays on `getQueueName`. */
const getScheduledQueueName = (moduleName) => `${moduleName}-scheduled-jobs`;

const QUEUE_NAMES = MODULES.flatMap((module) => [getQueueName(module), getScheduledQueueName(module)]);

let hasCleanedUp = false;

async function cleanupQueues() {
	if (hasCleanedUp) {
		return;
	}
	
	hasCleanedUp = true;

	const connection = {
		host: config.redis.host,
		port: config.redis.port
	};

	console.log('Cleaning up stale BullMQ jobs...');

	for (const name of QUEUE_NAMES) {
		try {
			const queue = new Queue(name, { connection });
			await queue.obliterate({ force: true });
			await queue.close();
		} catch (error) {
			// Queue may not exist yet, that's fine
		}
	}

	console.log('Queue cleanup complete.');
}

export {
	MODULES,
	QUEUE_NAMES,
	getQueueName,
	getScheduledQueueName,
	cleanupQueues
};
