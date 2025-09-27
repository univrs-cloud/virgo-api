const Application = require('./Application');
const Bookmark = require('./Bookmark');
const ConfigurationOrder = require('./ConfigurationOrder');

// Define associations
Application.hasOne(ConfigurationOrder, {
	foreignKey: 'itemId',
	constraints: false
});

Bookmark.hasOne(ConfigurationOrder, {
	foreignKey: 'itemId',
	constraints: false
});

ConfigurationOrder.belongsTo(Application, {
	foreignKey: 'itemId',
	constraints: false
});

ConfigurationOrder.belongsTo(Bookmark, {
	foreignKey: 'itemId',
	constraints: false
});

module.exports = {
	Application,
	Bookmark,
	ConfigurationOrder
};
