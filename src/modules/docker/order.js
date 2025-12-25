const DataService = require('../../database/data_service');

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

module.exports = {
	name: 'order',
	onConnection
};
