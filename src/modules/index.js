import config from '../../config.js';
import { cleanupQueues } from '../queues.js';
import createJobModule from './job/index.js';
import createConfigurationModule from './configuration/index.js';
import createHostModule from './host/index.js';
import createUserModule from './user/index.js';
import createDockerModule from './docker/index.js';
import createBookmarkModule from './bookmark/index.js';
import createShareModule from './share/index.js';
import createIndexerModule from './indexer/index.js';
import createWeatherModule from './weather/index.js';
import createFleetModule from './fleet/index.js';

export default async () => {
	await cleanupQueues();

	const modules = [
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

	if (config.fleet.url) {
		modules.push(createFleetModule());
	}

	return {
		modules
	};
};
