import DataService from '../../database/data_service.js';

const orderItems = async (config, socket, module) => {
	for (const item of config) {
		await DataService.setItemOrder(item.id, item.type, item.order);
	};
	module.eventEmitter.emit('configured:updated');
};

export default {
	name: 'order',
	commands: {
		'app:order': { handler: orderItems }
	}
};
