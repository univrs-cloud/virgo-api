import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { createLog } from '../utils/log.js';

const log = createLog('migrations');

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const moveDatabaseLocation = async () => {
	const oldDbPath = '/var/www/virgo-api/virgo.db';
	const newDbPath = '/messier/.config/virgo.db';
	const configDir = '/messier/.config';
	
	// Check if new database already exists
	try {
		await fs.access(newDbPath);
		log.info(`Database already exists at ${newDbPath}. Skipping movement.`);
		return;
	} catch (error) {
		// New database doesn't exist, safe to proceed
	}
	// Check if old database file exists
	try {
		await fs.access(oldDbPath);
		log.info(`Found existing database at ${oldDbPath}`);
	} catch (error) {
		log.info(`No existing database found at ${oldDbPath}.`);
		return;
	}
	// Check if messier ZFS pool exists
	const { exitCode: poolExists } = await execa('zpool', ['list', '-j', '-o', 'name', 'messier'], { reject: false });
	if (poolExists !== 0) {
		log.info(`ZFS pool 'messier' does not exist. Skipping database file movement.`);
		return;
	}
	log.info(`ZFS pool 'messier' exists`);
	// Ensure the new config directory exists
	try {
		await fs.access(configDir);
	} catch (error) {
		await fs.mkdir(configDir, { recursive: true });
		log.info(`Created config directory: ${configDir}`);
	}
		
	try {
		await fs.copyFile(oldDbPath, newDbPath);
		await fs.unlink(oldDbPath);
		log.info(`Successfully moved database from ${oldDbPath} to ${newDbPath}`);
		
	} catch (error) {
		log.error(`Database location movement failed:`, error);
		throw error;
	}
};

if (isMainModule) {
	moveDatabaseLocation();
}

export default moveDatabaseLocation;
