const DataService = require('../../database/data_service');

module.exports = {
	name: 'order',
	onConnection(socket, module) {
		socket.on('app:order', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			for (const item of config) {
				await DataService.setConfigurationOrder(item.id, item.type, item.order);
			};
			module.getInternalEmitter().emit('configured:updated');
		});
	}
};
