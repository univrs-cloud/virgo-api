const { sequelize } = require('../database/index');
const Configuration = require('../database/models/Configuration');
const Application = require('../database/models/Application');
const Bookmark = require('../database/models/Bookmark');

class DataService {
	static async initialize() {
		try {
			// Sync the models with the database
			await Configuration.sync({ force: false });
			await Application.sync({ force: false });
			await Bookmark.sync({ force: false });
			console.log('Database models synchronized.');
			
			return true;
		} catch (error) {
			console.error('Unable to connect to the database:', error);
			return false;
		}
	}

	static async getConfiguration() {
		try {
			const configs = await Configuration.findAll();
			const configuration = {};
			
			// Parse each configuration value
			for (const config of configs) {
				try {
					configuration[config.key] = JSON.parse(config.value);
				} catch (error) {
					configuration[config.key] = config.value;
				}
			}
			
			return configuration;
		} catch (error) {
			console.error('Error reading configuration from database:', error);
			// Return default configuration if database read fails
			return {
				location: {
					latitude: '45.749',
					longitude: '21.227'
				},
				smtp: null
			};
		}
	}

	static async setConfiguration(key, value) {
		try {
			const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
			
			await Configuration.upsert({
				key: key,
				value: stringValue
			});
			
			return true;
		} catch (error) {
			console.error(`Error writing configuration key '${key}' to database:`, error);
			return false;
		}
	}

	static async updateConfiguration(updates) {
		try {
			for (const [key, value] of Object.entries(updates)) {
				await this.setConfiguration(key, value);
			}
			return true;
		} catch (error) {
			console.error('Error updating configuration in database:', error);
			return false;
		}
	}

	// Application methods
	static async getApplications() {
		try {
			const applications = await Application.findAll({
				order: [['order', 'ASC'], ['name', 'ASC']]
			});
			return applications;
		} catch (error) {
			console.error('Error reading applications from database:', error);
			return [];
		}
	}

	static async getApplication(name) {
		try {
			const application = await Application.findOne({
				where: { name: name }
			});
			
			if (!application) {
				return null;
			}
			
			return application;
		} catch (error) {
			console.error(`Error reading application '${name}' from database:`, error);
			return null;
		}
	}

	static async setApplication(applicationData) {
		try {
			await Application.upsert({
				name: applicationData.name,
				canBeRemoved: applicationData.canBeRemoved,
				category: applicationData.category,
				title: applicationData.title,
				icon: applicationData.icon,
				url: applicationData.url,
				order: applicationData.order || 0
			});
			return true;
		} catch (error) {
			console.error(`Error writing application '${applicationData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteApplication(name) {
		try {
			const deleted = await Application.destroy({
				where: { name: name }
			});
			
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting application '${name}' from database:`, error);
			return false;
		}
	}

	// Bookmark methods
	static async getBookmarks() {
		try {
			const bookmarks = await Bookmark.findAll({
				order: [['order', 'ASC'], ['name', 'ASC']]
			});
			return bookmarks;
		} catch (error) {
			console.error('Error reading bookmarks from database:', error);
			return [];
		}
	}

	static async getBookmark(name) {
		try {
			const bookmark = await Bookmark.findOne({
				where: { name: name }
			});
			
			if (!bookmark) {
				return null;
			}
			
			return bookmark;
		} catch (error) {
			console.error(`Error reading bookmark '${name}' from database:`, error);
			return null;
		}
	}

	static async setBookmark(bookmarkData) {
		try {
			await Bookmark.upsert({
				name: bookmarkData.name,
				category: bookmarkData.category,
				title: bookmarkData.title,
				icon: bookmarkData.icon,
				url: bookmarkData.url,
				order: bookmarkData.order || 0
			});
			
			return true;
		} catch (error) {
			console.error(`Error writing bookmark '${bookmarkData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteBookmark(name) {
		try {
			const deleted = await Bookmark.destroy({
				where: { name: name }
			});
			
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting bookmark '${name}' from database:`, error);
			return false;
		}
	}

	// Helper method to get the next order value for applications
	static async getNextApplicationOrder() {
		try {
			const result = await Application.max('order');
			return (result || 0) + 1;
		} catch (error) {
			console.error('Error getting next application order:', error);
			return 1;
		}
	}

	// Helper method to get the next order value for bookmarks
	static async getNextBookmarkOrder() {
		try {
			const result = await Bookmark.max('order');
			return (result || 0) + 1;
		} catch (error) {
			console.error('Error getting next bookmark order:', error);
			return 1;
		}
	}

	// Helper method to update application order
	static async updateApplicationOrder(name, newOrder) {
		try {
			const [updated] = await Application.update(
				{ order: newOrder },
				{ where: { name: name } }
			);
			return updated > 0;
		} catch (error) {
			console.error(`Error updating application order for '${name}':`, error);
			return false;
		}
	}

	// Helper method to update bookmark order
	static async updateBookmarkOrder(name, newOrder) {
		try {
			const [updated] = await Bookmark.update(
				{ order: newOrder },
				{ where: { name: name } }
			);
			return updated > 0;
		} catch (error) {
			console.error(`Error updating bookmark order for '${name}':`, error);
			return false;
		}
	}

	static async close() {
		try {
			await sequelize.close();
			console.log('Database connection closed.');
		} catch (error) {
			console.error('Error closing database connection:', error);
		}
	}
}

module.exports = DataService;
