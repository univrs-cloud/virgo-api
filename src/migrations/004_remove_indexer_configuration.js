import fs from 'fs/promises';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileURLToPath } from 'url';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const DATABASE_FILE = '/messier/.config/virgo.db';
const STOP_ATTEMPTS = 100;
const STOP_INTERVAL = 100;

const exists = async (target) => {
	try {
		await fs.access(target);
		return true;
	} catch (error) {
		return false;
	}
};

const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return false;
	}
};

const stopIndexer = async (lockPath) => {
	let pid;
	let command;
	try {
		pid = parseInt((await fs.readFile(lockPath, 'utf8')).trim(), 10);
		command = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
	} catch (error) {
		return;
	}

	if (!Number.isInteger(pid) || pid <= 0 || !command.toLowerCase().includes('indexer')) {
		return;
	}

	console.log(`Stopping the running indexer (PID ${pid})...`);
	process.kill(pid, 'SIGTERM');
	for (let attempt = 0; attempt < STOP_ATTEMPTS && isAlive(pid); attempt++) {
		await sleep(STOP_INTERVAL);
	}
	if (isAlive(pid)) {
		process.kill(pid, 'SIGKILL');
		await sleep(STOP_INTERVAL);
	}
};

const removeIndexerConfiguration = async () => {
	try {
		if (!await exists(DATABASE_FILE)) {
			console.log(`No database file found. Skipping the indexer configuration removal.`);
			return;
		}

		const { default: DataService } = await import('../database/data_service.js');
		const configuration = await DataService.getConfiguration();
		if (!Object.hasOwn(configuration, 'indexer')) {
			console.log(`No indexer configuration found. Skipping its removal.`);
			return;
		}

		const { INDEX_DB_PATH } = await import('../../indexer/db.js');
		await stopIndexer(`${INDEX_DB_PATH}.lock`);
		for (const suffix of ['', '-wal', '-shm', '.lock']) {
			await fs.rm(`${INDEX_DB_PATH}${suffix}`, { force: true });
		}
		console.log(`Deleted the index database.`);

		if (!await DataService.deleteConfiguration('indexer')) {
			console.log(`Could not remove the indexer configuration.`);
			return;
		}

		console.log(`Removed the indexer configuration.`);
	} catch (error) {
		console.error(`Removing the indexer configuration failed:`, error);
	}
};

if (isMainModule) {
	removeIndexerConfiguration();
}

export default removeIndexerConfiguration;
