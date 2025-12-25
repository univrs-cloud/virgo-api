const { sequelize } = require('../database/index');

const renameConfigurationOrderTable = async () => {
	try {
		// Check if old table exists
		const [oldTables] = await sequelize.query(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='ConfigurationOrders'`
		);
		
		// Check if new table exists (either already renamed or created fresh)
		const [newTables] = await sequelize.query(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='ItemOrders'`
		);
		
		// If new table exists, skip rename (either already renamed or created fresh)
		if (newTables.length > 0) {
			// If old table also exists, drop it (shouldn't happen, but handle it)
			if (oldTables.length > 0) {
				console.log(`Both tables exist. Dropping old 'ConfigurationOrders' table.`);
				await sequelize.query(`DROP TABLE ConfigurationOrders`);
			} else {
				console.log(`Table 'ItemOrders' already exists. Skipping rename.`);
			}
			return;
		}
		
		// If old table exists, rename it
		if (oldTables.length > 0) {
			await sequelize.query(`ALTER TABLE ConfigurationOrders RENAME TO ItemOrders`);
			console.log(`Successfully renamed table 'ConfigurationOrders' to 'ItemOrders'`);
		} else {
			console.log(`Table 'ConfigurationOrders' does not exist. 'ItemOrders' will be created by model sync.`);
		}
		
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
