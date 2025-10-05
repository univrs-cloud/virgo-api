const { runMigrations } = require('./migrations');

const initializeDatabase = async () => {
	try {
		console.log(`Initializing database...`);
		await runMigrations();
		console.log(`Database initialization completed.`);
	} catch (error) {
		console.error(`Database initialization failed:`, error);
		throw error;
	}
};

module.exports = initializeDatabase;
