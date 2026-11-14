import fs from 'fs';
import { execa } from 'execa';
import ini from 'ini';

const rollbackFolder = async (job, module) => {
	const { config } = job.data;
	const { name } = config;
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

	const snapshotName = String(config?.snapshot ?? '');
	if (snapshotName === '') {
		throw new Error(`No snapshot was given to roll folder ${share.comment} back to.`);
	}

	const dataset = await module.pathToZfsDataset(share.path);
	if (!module.isFolderDataset(dataset)) {
		throw new Error(`Folder ${share.comment} cannot be rolled back.`);
	}

	const snapshot = `${dataset}@${snapshotName}`;
	const { exitCode } = await execa('zfs', ['list', '-H', '-o', 'name', '-t', 'snapshot', snapshot], { reject: false });
	if (exitCode !== 0) {
		throw new Error(`Folder ${share.comment} snapshot not found.`);
	}

	await module.updateJobProgress(job, `Rolling back folder ${share.comment}...`);
	try {
		await execa('zfs', ['rollback', '-r', snapshot]);
	} catch (error) {
		throw new Error(`Could not roll back folder ${share.comment}.`);
	}

	return `Folder ${share.comment} rolled back.`;
};

export default {
	name: 'rollback',
	commands: {
		'share:rollback': { job: 'share:rollback' }
	},
	jobs: {
		'share:rollback': async (job, module) => {
			try {
				return await rollbackFolder(job, module);
			} finally {
				module.eventEmitter.emit('host:storage:snapshots:fetch');
				module.eventEmitter.emit('shares:updated');
			}
		}
	}
};
