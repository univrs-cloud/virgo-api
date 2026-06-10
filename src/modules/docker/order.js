import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('app:order', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		for (const item of config) {
			await DataService.setItemOrder(item.id, item.type, item.order);
		};
		module.eventEmitter.emit('configured:updated');
	});
};

export default {
	name: 'order',
	onConnection
};
