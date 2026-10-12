import fs from 'fs';
import ini from 'ini';
import * as sanoid from '../../utils/sanoid.js';

const updateSnapshots = async (job, module) => {
	const { config } = job.data;
	const { name } = config;
	const mode = String(config?.mode ?? '').toLowerCase();
	if (!sanoid.MODES.includes(mode)) {
		throw new Error(`Snapshots mode must be one of: ${sanoid.MODES.join(', ')}.`);
	}

	const shareConfigFile = await module.findFolderShareConfigFile(name);
	if (shareConfigFile === null) {
		throw new Error(`Folder "${name}" not found in config.`);
	}

	let shares = {};
	try {
		shares = ini.parse(fs.readFileSync(shareConfigFile, 'utf8'));
	} catch (error) {
		throw new Error(`Cannot read config: ${error.message}`);
	}
	const share = shares[name];
	if (!share?.path) {
		throw new Error(`Folder "${share?.comment || name}" has no path.`);
	}

	const dataset = await module.pathToZfsDataset(share.path);
	if (!module.isFolderDataset(dataset)) {
		throw new Error(`Snapshots of folder "${share.comment}" cannot be changed.`);
	}

	await module.updateJobProgress(job, `Updating folder ${share.comment} snapshots...`);
	await sanoid.setMode(dataset, mode);
	module.eventEmitter.emit('shares:updated');
	return `Folder ${share.comment} snapshots ${mode}.`;
};

export default {
	name: 'snapshots',
	commands: {
		'share:snapshots:update': { job: 'share:snapshots:update' }
	},
	jobs: {
		'share:snapshots:update': updateSnapshots
	}
};
