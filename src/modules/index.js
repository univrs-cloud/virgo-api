import { cleanupQueues } from '../queues.js';
import createRuntimeModule from './runtime/index.js';
import createJobModule from './job/index.js';
import createConfigurationModule from './configuration/index.js';
import createHostModule from './host/index.js';
import createUserModule from './user/index.js';
import createDockerModule from './docker/index.js';
import createBookmarkModule from './bookmark/index.js';
import createShareModule from './share/index.js';
import createIndexerModule from './indexer/index.js';
import createWeatherModule from './weather/index.js';

export default async () => {
	await cleanupQueues();

	const modules = [
		createRuntimeModule(),
		createJobModule(),
		createConfigurationModule(),
		createHostModule(),
		createUserModule(),
		createDockerModule(),
		createBookmarkModule(),
		createShareModule(),
		createIndexerModule(),
		createWeatherModule()
	];

	return {
		modules
	};
};
