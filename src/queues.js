const { Queue } = require('bullmq');
const config = require('../config');

const MODULES = [
	'job',
	'configuration',
	'host',
	'user',
	'docker',
	'bookmark',
	'share',
	'metrics',
	'weather'
];

const getQueueName = (moduleName) => `${moduleName}-jobs`;

const QUEUE_NAMES = MODULES.map(getQueueName);

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

module.exports = {
	MODULES,
	QUEUE_NAMES,
	getQueueName,
	cleanupQueues
};
