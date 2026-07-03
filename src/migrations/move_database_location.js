import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';

const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const moveDatabaseLocation = async () => {
	const oldDbPath = '/var/www/virgo-api/virgo.db';
	const newDbPath = '/messier/.config/virgo.db';
	const configDir = '/messier/.config';
	
	// Check if new database already exists
	try {
		await fs.access(newDbPath);
		console.log(`Database already exists at ${newDbPath}. Skipping movement.`);
		return;
	} catch (error) {
		// New database doesn't exist, safe to proceed
	}
	// Check if old database file exists
	try {
		await fs.access(oldDbPath);
		console.log(`Found existing database at ${oldDbPath}`);
	} catch (error) {
		console.log(`No existing database found at ${oldDbPath}.`);
		return;
	}
	// Check if messier ZFS pool exists
	try {
		await execa('zpool', ['list', 'messier']);
		console.log(`ZFS pool 'messier' exists`);
	} catch (error) {
		console.log(`ZFS pool 'messier' does not exist. Skipping database file movement.`);
		return;
	}
	// Ensure the new config directory exists
	try {
		await fs.access(configDir);
	} catch (error) {
		await fs.mkdir(configDir, { recursive: true });
		console.log(`Created config directory: ${configDir}`);
	}
		
	try {
		await fs.copyFile(oldDbPath, newDbPath);
		await fs.unlink(oldDbPath);
		console.log(`Successfully moved database from ${oldDbPath} to ${newDbPath}`);
		
	} catch (error) {
		console.error(`Database location movement failed:`, error);
		throw error;
	}
};

if (isMainModule) {
	moveDatabaseLocation();
}

export default moveDatabaseLocation;
