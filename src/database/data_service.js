const { sequelize } = require('../database/index');
const Configuration = require('../database/models/Configuration');
const { Application, Bookmark, ConfigurationOrder } = require('../database/models/associations');

class DataService {
	static async initialize() {
		try {
			// Sync the models with the database
			await Configuration.sync({ force: false });
			await Application.sync({ force: false });
			await Bookmark.sync({ force: false });
			await ConfigurationOrder.sync({ force: false });
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
				raw: true
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
				where: { name: name },
				raw: true
			});
			return application;
		} catch (error) {
			console.error(`Error reading application '${name}' from database:`, error);
			return null;
		}
	}

	static async setApplication(applicationData) {
		try {
			const [ entry ] = await Application.upsert({
				name: applicationData.name,
				canBeRemoved: applicationData.canBeRemoved,
				category: applicationData.category,
				title: applicationData.title,
				icon: applicationData.icon,
				url: applicationData.url
			}, { returning: true });
			const application = entry.get({ plain: true });
			const order = await DataService.getNextOrderForCategory(application.category);
			await DataService.setConfigurationOrder(application.id, 'app', order);
			return true;
		} catch (error) {
			console.error(`Error writing application '${applicationData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteApplication(name) {
		try {
			// Get the application first to get its ID
			const application = await Application.findOne({
				where: { name: name }
			});
			
			if (!application) {
				return false;
			}
			
			// Delete the application
			const deleted = await Application.destroy({
				where: { name: name }
			});
			
			if (deleted > 0) {
				// Also delete the configuration order entry
				await DataService.deleteConfigurationOrder(application.id, 'app');
			}
			
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
				raw: true
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
				where: { name: name },
				raw: true
			});
			return bookmark;
		} catch (error) {
			console.error(`Error reading bookmark '${name}' from database:`, error);
			return null;
		}
	}

	static async setBookmark(bookmarkData) {
		try {
			const [ entry ] = await Bookmark.upsert({
				name: bookmarkData.name,
				category: bookmarkData.category,
				title: bookmarkData.title,
				icon: bookmarkData.icon,
				url: bookmarkData.url
			}, { returning: true });
			const bookmark = entry.get({ plain: true });
			const order = await DataService.getNextOrderForCategory(bookmark.category);
			await DataService.setConfigurationOrder(bookmark.id, 'bookmark', order);
			return true;
		} catch (error) {
			console.error(`Error writing bookmark '${bookmarkData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteBookmark(name) {
		try {
			// Get the bookmark first to get its ID
			const bookmark = await Bookmark.findOne({
				where: { name: name }
			});
			
			if (!bookmark) {
				return false;
			}
			
			// Delete the bookmark
			const deleted = await Bookmark.destroy({
				where: { name: name }
			});
			
			if (deleted > 0) {
				// Also delete the configuration order entry
				await DataService.deleteConfigurationOrder(bookmark.id, 'bookmark');
			}
			
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting bookmark '${name}' from database:`, error);
			return false;
		}
	}

	static async setConfigurationOrder(itemId, type, order) {
		try {
			await ConfigurationOrder.upsert({
				itemId: itemId,
				type: type,
				order: order
			});
			return true;
		} catch (error) {
			console.error(`Error writing configuration order for item ${itemId} (${type}) to database:`, error);
			return false;
		}
	}

	static async deleteConfigurationOrder(itemId, type) {
		try {
			const deleted = await ConfigurationOrder.destroy({
				where: { 
					itemId: itemId,
					type: type
				}
			});
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting configuration order for item ${itemId} (${type}):`, error);
			return false;
		}
	}

	static async getConfiguration() {
		try {
			const entries = await ConfigurationOrder.findAll({
				include: [
					{
						model: Application,
						required: false
					},
					{
						model: Bookmark,
						required: false
					}
				]
			});
			
			return entries
				.filter((entry) => {
					return entry.Application || entry.Bookmark;
				})
				.map((entry) => {
					const entryData = entry.get({ plain: true });
					return {
						...(entryData.type === 'app' ? entryData.Application : entryData.Bookmark),
						type: entryData.type,
						order: entryData.order
					};
				});
		} catch (error) {
			console.error('Error getting configuration order with items:', error);
			return [];
		}
	}

	static async getNextOrderForCategory(category) {
		try {
			// Get all order entries for apps in this category using associations
			const appOrderEntries = await ConfigurationOrder.findAll({
				include: [{
					model: Application,
					where: { category: category },
					attributes: []
				}],
				attributes: ['order']
			});
			
			// Get all order entries for bookmarks in this category using associations
			const bookmarkOrderEntries = await ConfigurationOrder.findAll({
				include: [{
					model: Bookmark,
					where: { category: category },
					attributes: []
				}],
				attributes: ['order']
			});
			
			// Find the highest order in this category
			const allOrders = [...appOrderEntries, ...bookmarkOrderEntries].map(entry => entry.order);
			const maxOrder = allOrders.length > 0 ? Math.max(...allOrders) : 0;
			
			return maxOrder + 1;
		} catch (error) {
			console.error(`Error getting next order for category '${category}':`, error);
			return 1;
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
