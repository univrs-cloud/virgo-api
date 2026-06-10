import Application from './Application.js';
import Bookmark from './Bookmark.js';
import ItemOrder from './ItemOrder.js';

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

export {
	Application,
	Bookmark,
	ItemOrder
};
