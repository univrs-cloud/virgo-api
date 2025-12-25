const Application = require('./Application');
const Bookmark = require('./Bookmark');
const ItemOrder = require('./ItemOrder');

// Define associations
Application.hasOne(ItemOrder, {
	foreignKey: 'itemId',
	constraints: false
});

Bookmark.hasOne(ItemOrder, {
	foreignKey: 'itemId',
	constraints: false
});

ItemOrder.belongsTo(Application, {
	foreignKey: 'itemId',
	constraints: false
});

ItemOrder.belongsTo(Bookmark, {
	foreignKey: 'itemId',
	constraints: false
});

module.exports = {
	Application,
	Bookmark,
	ItemOrder
};
