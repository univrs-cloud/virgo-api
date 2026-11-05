import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const OLD_DATASET = 'messier/time_machines';
const NEW_DATASET = 'messier/time_capsule';
const OLD_MOUNTPOINT = '/time_machines';
const NEW_MOUNTPOINT = '/time_capsule';
const SHARES_DIR = '/messier/.shares';
const ALL_CONF = `${SHARES_DIR}/all.conf`;
const OLD_CONF = `${SHARES_DIR}/time_machines.conf`;
const NEW_CONF = `${SHARES_DIR}/time_capsule.conf`;
const OLD_SHARE_PREFIX = 'time_machine_';
const NEW_SHARE_PREFIX = 'backup_disk_';
const OLD_SHARE_SECTION = new RegExp(`^(\\s*\\[)${OLD_SHARE_PREFIX}`, 'gmi');
const OLD_SHARE_PATH = new RegExp(`^(\\s*path\\s*=\\s*)${OLD_MOUNTPOINT}/`, 'gmi');
const SAMBA_UNIT = 'smbd.service';

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const datasetExists = async (name) => {
	const { exitCode } = await execa('zfs', ['list', '-H', '-o', 'name', name], { reject: false });
	return exitCode === 0;
};

const renameDataset = async () => {
	if (await datasetExists(OLD_DATASET)) {
		if (await datasetExists(NEW_DATASET)) {
			console.log(`Both ${OLD_DATASET} and ${NEW_DATASET} exist. Leaving them in place for manual review.`);
			return false;
		}

		await execa('zfs', ['rename', OLD_DATASET, NEW_DATASET]);
		console.log(`Renamed ${OLD_DATASET} to ${NEW_DATASET}.`);
	}

	if (!await datasetExists(NEW_DATASET)) {
		console.log(`Dataset ${NEW_DATASET} does not exist. Skipping the mountpoint change.`);
		return false;
	}

	const { stdout: mountpoint } = await execa('zfs', ['get', '-H', '-o', 'value', 'mountpoint', NEW_DATASET]);
	if (mountpoint.trim() !== NEW_MOUNTPOINT) {
		await execa('zfs', ['set', `mountpoint=${NEW_MOUNTPOINT}`, NEW_DATASET]);
		await fs.rmdir(OLD_MOUNTPOINT).catch(() => {});
		console.log(`Mounted ${NEW_DATASET} at ${NEW_MOUNTPOINT}.`);
	}

	return true;
};

const renameConfiguration = async () => {
	if (await exists(OLD_CONF)) {
		if (await exists(NEW_CONF)) {
			console.log(`Both ${OLD_CONF} and ${NEW_CONF} exist. Leaving them in place for manual review.`);
			return false;
		}

		await fs.rename(OLD_CONF, NEW_CONF);
		console.log(`Renamed ${OLD_CONF} to ${NEW_CONF}.`);
	}

	if (await exists(ALL_CONF)) {
		const includes = await fs.readFile(ALL_CONF, 'utf8');
		const updated = includes.split(OLD_CONF).join(NEW_CONF);
		if (updated !== includes) {
			await fs.writeFile(ALL_CONF, updated, 'utf8');
			console.log(`Updated the include in ${ALL_CONF}.`);
		}
	}

	return true;
};

const rewriteShares = async () => {
	const shares = await fs.readFile(NEW_CONF, 'utf8').catch(() => { return null; });
	if (shares === null) {
		return;
	}

	const updated = shares
		.replace(OLD_SHARE_PATH, `$1${NEW_MOUNTPOINT}/`)
		.replace(OLD_SHARE_SECTION, `$1${NEW_SHARE_PREFIX}`);
	if (updated !== shares) {
		await fs.writeFile(NEW_CONF, updated, 'utf8');
		console.log(`Moved the shares in ${NEW_CONF} to ${NEW_MOUNTPOINT} and renamed them to ${NEW_SHARE_PREFIX}.`);
	}
};

const hasOldLayout = async () => {
	if (await datasetExists(OLD_DATASET) || await exists(OLD_CONF)) {
		return true;
	}

	const includes = await fs.readFile(ALL_CONF, 'utf8').catch(() => { return ''; });
	const shares = await fs.readFile(NEW_CONF, 'utf8').catch(() => { return ''; });
	return includes.includes(OLD_CONF) || new RegExp(OLD_SHARE_SECTION.source, 'mi').test(shares) || new RegExp(OLD_SHARE_PATH.source, 'mi').test(shares);
};

const renameTimeMachinesToTimeCapsule = async () => {
	try {
		if (!await hasOldLayout()) {
			console.log(`No time machines layout found. Skipping the time capsule rename.`);
			return;
		}

		await execa('systemctl', ['stop', SAMBA_UNIT], { reject: false });
		try {
			if (await renameDataset() && await renameConfiguration()) {
				await rewriteShares();
			}
		} finally {
			await execa('systemctl', ['start', SAMBA_UNIT], { reject: false });
		}
	} catch (error) {
		console.error(`Renaming time machines to time capsule failed:`, error);
	}
};

if (isMainModule) {
	renameTimeMachinesToTimeCapsule();
}

export default renameTimeMachinesToTimeCapsule;
