import Application from './Application.js';
import Shortcut from './Shortcut.js';
import ItemOrder from './ItemOrder.js';

// Define associations
Application.hasOne(ItemOrder, {
	foreignKey: 'itemId',
	constraints: false
});

Shortcut.hasOne(ItemOrder, {
	foreignKey: 'itemId',
	constraints: false
});

ItemOrder.belongsTo(Application, {
	foreignKey: 'itemId',
	constraints: false
});

ItemOrder.belongsTo(Shortcut, {
	foreignKey: 'itemId',
	constraints: false
});

export {
	Application,
	Shortcut,
	ItemOrder
};
