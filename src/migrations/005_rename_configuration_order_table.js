const { sequelize } = require('../database/index');

const renameConfigurationOrderTable = async () => {
	try {
		// Check if old table exists
		const [tables] = await sequelize.query(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='ConfigurationOrders'`
		);
		
		if (tables.length === 0) {
			console.log(`Table 'ConfigurationOrders' does not exist. Skipping rename.`);
			return;
		}
		
		// Check if new table already exists
		const [newTables] = await sequelize.query(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='ItemOrders'`
		);
		
		if (newTables.length > 0) {
			console.log(`Table 'ItemOrders' already exists. Skipping rename.`);
			return;
		}
		
		// Rename the table
		await sequelize.query(`ALTER TABLE ConfigurationOrders RENAME TO ItemOrders`);
		console.log(`Successfully renamed table 'ConfigurationOrders' to 'ItemOrders'`);
	} catch (error) {
		console.error(`Table rename failed:`, error);
		throw error;
	}
};

// Run if this file is executed directly
if (require.main === module) {
	renameConfigurationOrderTable();
}

module.exports = renameConfigurationOrderTable;

