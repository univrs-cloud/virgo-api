const { sequelize } = require('../database/index');
const Configuration = require('../database/models/Configuration');
const { Application, Bookmark, ItemOrder } = require('../database/models/associations');
const traefikConfig = require('../utils/traefik_config');

class DataService {
	static async initialize() {
		try {
			// Sync the models with the database
			await Configuration.sync({ force: false });
			await Application.sync({ force: false });
			await Bookmark.sync({ force: false });
			await ItemOrder.sync({ force: false });
			console.log(`Database models synchronized.`);
			
			return true;
		} catch (error) {
			console.error(`Unable to connect to the database:`, error);
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
			console.error(`Error reading configuration from database:`, error);
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
			console.error(`Error updating configuration in database:`, error);
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
			console.error(`Error reading applications from database:`, error);
			return [];
		}
	}

	static async getApplication(name) {
		try {
			const application = await Application.findOne({
				where: { name },
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
				icon: applicationData.icon
			}, { returning: true });
			const application = entry.get({ plain: true });
			const order = await DataService.getNextOrderForCategory(application.category);
			await DataService.setItemOrder(application.id, 'app', order);
			return true;
		} catch (error) {
			console.error(`Error writing application '${applicationData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteApplication(name) {
		try {
			const application = await Application.findOne({
				where: { name }
			});
			if (!application) {
				return false;
			}

			await DataService.deleteItemOrder(application.id, 'app');
			const deleted = await Application.destroy({
				where: { name }
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
				raw: true
			});
			return await traefikConfig.enrichBookmarks(bookmarks);
		} catch (error) {
			console.error(`Error reading bookmarks from database:`, error);
			return [];
		}
	}

	static async getBookmark(name) {
		try {
			const bookmark = await Bookmark.findOne({
				where: { name },
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
			const { traefik, ...bookmarkFields } = bookmarkData;
			
			// Get existing bookmark if updating (by id) to find old traefik config
			let existingBookmark = null;
			if (bookmarkFields.id) {
				existingBookmark = await Bookmark.findByPk(bookmarkFields.id, { raw: true });
			}
			
			const [ entry ] = await Bookmark.upsert({
				id: bookmarkFields.id,
				name: bookmarkFields.name,
				category: bookmarkFields.category,
				title: bookmarkFields.title,
				icon: bookmarkFields.icon,
				url: bookmarkFields.url
			}, { returning: true });
			const bookmark = entry.get({ plain: true });
			const order = await DataService.getNextOrderForCategory(bookmark.category);
			await DataService.setItemOrder(bookmark.id, 'bookmark', order);
			
			// Handle Traefik config
			// Find existing config using OLD url (if updating) or new url (if creating)
			const configs = await traefikConfig.readAll();
			const oldUrl = existingBookmark?.url || bookmarkFields.url;
			const existingConfig = configs.find((c) => traefikConfig.match(c, { url: oldUrl }));
			
			if (traefik === null) {
				// Explicitly set to null - delete existing config
				if (existingConfig) {
					await traefikConfig.remove(existingConfig.subdomain);
				}
			} else if (traefik) {
				// Delete old config if subdomain changed
				if (existingConfig && existingConfig.subdomain !== traefik.subdomain) {
					await traefikConfig.remove(existingConfig.subdomain);
				}
				// Write new/updated config using subdomain as filename
				await traefikConfig.write(traefik.subdomain, {
					subdomain: traefik.subdomain,
					backendUrl: traefik.backendUrl,
					isAuthRequired: traefik.isAuthRequired ?? true
				});
			}
			
			return true;
		} catch (error) {
			console.error(`Error writing bookmark '${bookmarkData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteBookmark(name) {
		try {
			const bookmark = await Bookmark.findOne({
				where: { name }
			});
			if (!bookmark) {
				return false;
			}
			
			// Find and delete associated Traefik config file (if it exists)
			const configs = await traefikConfig.readAll();
			const existingConfig = configs.find((c) => traefikConfig.match(c, { url: bookmark.url }));
			if (existingConfig) {
				await traefikConfig.remove(existingConfig.subdomain);
			}
			
			await DataService.deleteItemOrder(bookmark.id, 'bookmark');
			const deleted = await Bookmark.destroy({
				where: { name }
			});
			
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting bookmark '${name}' from database:`, error);
			return false;
		}
	}

	static async setItemOrder(itemId, type, order) {
		try {
			await ItemOrder.upsert({
				itemId: itemId,
				type: type,
				order: order
			});
			return true;
		} catch (error) {
			console.error(`Error writing item order for ${itemId} (${type}) to database:`, error);
			return false;
		}
	}

	static async deleteItemOrder(itemId, type) {
		try {
			const deleted = await ItemOrder.destroy({
				where: { 
					itemId: itemId,
					type: type
				}
			});
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting item order for ${itemId} (${type}):`, error);
			return false;
		}
	}

	static async getConfigured() {
		try {
			const applications = await Application.findAll({
				include: [{
					model: ItemOrder,
					required: false,
					where: { type: 'app' }
				}]
			});
			const bookmarks = await Bookmark.findAll({
				include: [{
					model: ItemOrder,
					required: false,
					where: { type: 'bookmark' }
				}]
			});
			const appEntries = applications.map((app) => {
				const { ItemOrder, ...data } = app.get({ plain: true });
				return { ...data, type: 'app', order: ItemOrder?.order ?? null };
			});
			const bookmarkEntries = bookmarks.map((bookmark) => {
				const { ItemOrder, ...data } = bookmark.get({ plain: true });
				return { ...data, type: 'bookmark', order: ItemOrder?.order ?? null };
			});
			const enrichedBookmarkEntries = await traefikConfig.enrichBookmarks(bookmarkEntries);
			return [...appEntries, ...enrichedBookmarkEntries];
		} catch (error) {
			console.error(`Error getting configured items:`, error);
			return [];
		}
	}

	static async getNextOrderForCategory(category) {
		try {
			const appOrderEntries = await ItemOrder.findAll({
				include: [{
					model: Application,
					where: { category },
					attributes: []
				}],
				attributes: ['order']
			});
			const bookmarkOrderEntries = await ItemOrder.findAll({
				include: [{
					model: Bookmark,
					where: { category },
					attributes: []
				}],
				attributes: ['order']
			});
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
			console.log(`Database connection closed.`);
		} catch (error) {
			console.error(`Error closing database connection:`, error);
		}
	}
}

module.exports = DataService;
