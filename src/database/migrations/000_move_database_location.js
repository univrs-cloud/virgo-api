const fs = require('fs');
const { execa } = require('execa');

const moveDatabaseLocation = async () => {
	const oldDbPath = '/var/www/virgo-api/virgo.db';
	const newDbPath = '/messier/.config/virgo.db';
	const configDir = '/messier/.config';
	
	try {
		// Check if new database already exists
		try {
			await fs.promises.access(newDbPath);
			console.log(`Database already exists at ${newDbPath}. Skipping movement.`);
			return;
		} catch (error) {
			// New database doesn't exist, safe to proceed
		}
		// Check if old database file exists
		try {
			await fs.promises.access(oldDbPath);
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
			await fs.promises.access(configDir);
		} catch (error) {
			await fs.promises.mkdir(configDir, { recursive: true });
			console.log(`Created config directory: ${configDir}`);
		}
		
		// Copy the database file (cross-device move)
		await fs.promises.copyFile(oldDbPath, newDbPath);
		// Remove the original file after successful copy
		await fs.promises.unlink(oldDbPath);
		console.log(`Successfully moved database from ${oldDbPath} to ${newDbPath}`);
		
	} catch (error) {
		console.error(`Database location movement failed:`, error);
		throw error;
	}
};

// Run migration if this file is executed directly
if (require.main === module) {
	moveDatabaseLocation();
}

module.exports = moveDatabaseLocation;
