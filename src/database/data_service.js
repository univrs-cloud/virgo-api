import { sequelize, ensureOpen } from './index.js';
import Configuration from './models/Configuration.js';
import { Application, Shortcut, ItemOrder } from './models/associations.js';
import * as traefikConfig from '../utils/traefik_config.js';
import { getCoreApps } from '../utils/core_apps.js';

const DEFAULT_CONFIGURATION = {
	location: {
		latitude: '45.749',
		longitude: '21.227'
	},
	smtp: null,
	trustedProxies: [],
	indexer: []
};

class DataService {
	static async initialize() {
		if (!await ensureOpen()) {
			return false;
		}

		try {
			await Configuration.sync({ force: false });
			await Application.sync({ force: false });
			await Shortcut.sync({ force: false });
			await ItemOrder.sync({ force: false });
			console.log(`Database models synchronized.`);
			await Application.update({ canBeRemoved: false }, { where: { name: getCoreApps(), canBeRemoved: true } });
			return true;
		} catch (error) {
			console.error(`Unable to connect to the database:`, error);
			return false;
		}
	}

	static async getConfiguration() {
		if (!await ensureOpen()) {
			return structuredClone(DEFAULT_CONFIGURATION);
		}

		try {
			const configs = await Configuration.findAll();
			const configuration = {};
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
			return structuredClone(DEFAULT_CONFIGURATION);
		}
	}

	static async setConfiguration(key, value) {
		if (!await ensureOpen()) {
			return false;
		}

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

	static async deleteConfiguration(key) {
		if (!await ensureOpen()) {
			return false;
		}

		try {
			await Configuration.destroy({ where: { key } });
			return true;
		} catch (error) {
			console.error(`Error deleting configuration key '${key}' from database:`, error);
			return false;
		}
	}

	static async updateConfiguration(updates) {
		if (!await ensureOpen()) {
			return false;
		}

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
		if (!await ensureOpen()) {
			return [];
		}

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
		if (!await ensureOpen()) {
			return null;
		}

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
		if (!await ensureOpen()) {
			return false;
		}

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
		if (!await ensureOpen()) {
			return false;
		}

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

	// Shortcut methods
	static async getShortcuts() {
		if (!await ensureOpen()) {
			return [];
		}

		try {
			const shortcuts = await Shortcut.findAll({
				raw: true
			});
			return await traefikConfig.enrichShortcuts(shortcuts);
		} catch (error) {
			console.error(`Error reading shortcuts from database:`, error);
			return [];
		}
	}

	static async getShortcut(name) {
		if (!await ensureOpen()) {
			return null;
		}

		try {
			const shortcut = await Shortcut.findOne({
				where: { name },
				raw: true
			});
			return shortcut;
		} catch (error) {
			console.error(`Error reading shortcut '${name}' from database:`, error);
			return null;
		}
	}

	static async setShortcut(shortcutData) {
		if (!await ensureOpen()) {
			return false;
		}

		try {
			const { traefik, ...shortcutFields } = shortcutData;
			
			// Get existing shortcut if updating (by id) to find old traefik config
			let existingShortcut = null;
			if (shortcutFields.id) {
				existingShortcut = await Shortcut.findByPk(shortcutFields.id, { raw: true });
			}
			
			const [ entry ] = await Shortcut.upsert({
				id: shortcutFields.id,
				name: shortcutFields.name,
				category: shortcutFields.category,
				title: shortcutFields.title,
				icon: shortcutFields.icon,
				url: shortcutFields.url
			}, { returning: true });
			const shortcut = entry.get({ plain: true });
			const order = await DataService.getNextOrderForCategory(shortcut.category);
			await DataService.setItemOrder(shortcut.id, 'shortcut', order);
			
			// Handle Traefik config
			// Find existing config using OLD url (if updating) or new url (if creating)
			const configs = await traefikConfig.readAll();
			const oldUrl = existingShortcut?.url || shortcutFields.url;
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
			console.error(`Error writing shortcut '${shortcutData.name}' to database:`, error);
			return false;
		}
	}
	
	static async deleteShortcut(name) {
		if (!await ensureOpen()) {
			return false;
		}

		try {
			const shortcut = await Shortcut.findOne({
				where: { name }
			});
			if (!shortcut) {
				return false;
			}
			
			// Find and delete associated Traefik config file (if it exists)
			const configs = await traefikConfig.readAll();
			const existingConfig = configs.find((c) => traefikConfig.match(c, { url: shortcut.url }));
			if (existingConfig) {
				await traefikConfig.remove(existingConfig.subdomain);
			}
			
			await DataService.deleteItemOrder(shortcut.id, 'shortcut');
			const deleted = await Shortcut.destroy({
				where: { name }
			});
			
			return deleted > 0;
		} catch (error) {
			console.error(`Error deleting shortcut '${name}' from database:`, error);
			return false;
		}
	}

	static async setItemOrder(itemId, type, order) {
		if (!await ensureOpen()) {
			return false;
		}

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
		if (!await ensureOpen()) {
			return false;
		}

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
		if (!await ensureOpen()) {
			return [];
		}

		try {
			const applications = await Application.findAll({
				include: [{
					model: ItemOrder,
					required: false,
					where: { type: 'app' }
				}]
			});
			const shortcuts = await Shortcut.findAll({
				include: [{
					model: ItemOrder,
					required: false,
					where: { type: 'shortcut' }
				}]
			});
			const appEntries = applications.map((app) => {
				const { ItemOrder, ...data } = app.get({ plain: true });
				return { ...data, type: 'app', order: ItemOrder?.order ?? null };
			});
			const shortcutEntries = shortcuts.map((shortcut) => {
				const { ItemOrder, ...data } = shortcut.get({ plain: true });
				return { ...data, type: 'shortcut', order: ItemOrder?.order ?? null };
			});
			const enrichedShortcutEntries = await traefikConfig.enrichShortcuts(shortcutEntries);
			return [...appEntries, ...enrichedShortcutEntries];
		} catch (error) {
			console.error(`Error getting configured items:`, error);
			return [];
		}
	}

	static async getNextOrderForCategory(category) {
		if (!await ensureOpen()) {
			return 1;
		}

		try {
			const appOrderEntries = await ItemOrder.findAll({
				include: [{
					model: Application,
					where: { category },
					attributes: []
				}],
				attributes: ['order']
			});
			const shortcutOrderEntries = await ItemOrder.findAll({
				include: [{
					model: Shortcut,
					where: { category },
					attributes: []
				}],
				attributes: ['order']
			});
			const allOrders = [...appOrderEntries, ...shortcutOrderEntries].map(entry => entry.order);
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

export default DataService;
