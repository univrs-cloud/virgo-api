const Application = require('./Application');
const Bookmark = require('./Bookmark');
const ConfigurationOrder = require('./ConfigurationOrder');

// Define associations
Application.hasOne(ConfigurationOrder, {
	foreignKey: 'itemId',
	constraints: false,
	scope: {
		type: 'app'
	}
});

Bookmark.hasOne(ConfigurationOrder, {
	foreignKey: 'itemId',
	constraints: false,
	scope: {
		type: 'bookmark'
	}
});

ConfigurationOrder.belongsTo(Application, {
	foreignKey: 'itemId',
	constraints: false,
	scope: {
		type: 'app'
	}
});

ConfigurationOrder.belongsTo(Bookmark, {
	foreignKey: 'itemId',
	constraints: false,
	scope: {
		type: 'bookmark'
	}
});

module.exports = {
	Application,
	Bookmark,
	ConfigurationOrder
};
