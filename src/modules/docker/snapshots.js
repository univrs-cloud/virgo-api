import DataService from '../../database/data_service.js';
import { isCoreApp } from '../../utils/core_apps.js';
import * as sanoid from '../../utils/sanoid.js';

const updateSnapshots = async (job, module) => {
	const { config } = job.data;
	const mode = String(config?.mode ?? '').toLowerCase();
	if (!sanoid.MODES.includes(mode)) {
		throw new Error(`Snapshots mode must be one of: ${sanoid.MODES.join(', ')}.`);
	}

	const app = await DataService.getApplication(config?.name);
	if (!app) {
		throw new Error(`App not found.`);
	}

	if (isCoreApp(app.name)) {
		throw new Error(`Snapshots of ${app.title} cannot be changed.`);
	}

	if (mode !== 'disabled' && !(await module.hasDatasetMounts(app.name))) {
		throw new Error(`${app.title} keeps no data to snapshot.`);
	}

	await module.updateJobProgress(job, `Updating ${app.title} snapshots...`);
	await sanoid.setMode(`${module.appsDataset}/${app.name}`, mode);
	module.eventEmitter.emit('configured:updated');
	return `${app.title} snapshots ${mode}.`;
};

export default {
	name: 'snapshots',
	commands: {
		'app:snapshots:update': { job: 'app:snapshots:update' }
	},
	jobs: {
		'app:snapshots:update': (job, module) => {
			return module.withAppLock(job.data?.config?.name, () => { return updateSnapshots(job, module); });
		}
	}
};
