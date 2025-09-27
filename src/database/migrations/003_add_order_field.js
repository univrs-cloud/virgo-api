const { sequelize } = require('../index');

const addOrderField = async () => {
	try {
		console.log('Adding order field to Applications and Bookmarks tables...');
		
		// Add order column to Applications table
		await sequelize.query(`
			ALTER TABLE Applications ADD COLUMN \`order\` INTEGER NOT NULL DEFAULT 0;
		`);
		console.log('Added order column to Applications table');
		
		// Add order column to Bookmarks table
		await sequelize.query(`
			ALTER TABLE Bookmarks ADD COLUMN \`order\` INTEGER NOT NULL DEFAULT 0;
		`);
		console.log('Added order column to Bookmarks table');
		
		// Update existing records to have incremental order values
		await sequelize.query(`
			UPDATE Applications SET \`order\` = id;
		`);
		console.log('Updated existing applications with order values');
		
		await sequelize.query(`
			UPDATE Bookmarks SET \`order\` = id;
		`);
		console.log('Updated existing bookmarks with order values');
		
		console.log('Order field migration completed successfully!');
		
	} catch (error) {
		// Check if the column already exists (common error when running migration multiple times)
		if (error.message.includes('duplicate column name') || error.message.includes('column already exists')) {
			console.log('Order columns already exist, skipping migration.');
		} else {
			console.error('Migration failed:', error);
		}
	}
};

// Run migration if this file is executed directly
if (require.main === module) {
	addOrderField();
}

module.exports = addOrderField;
