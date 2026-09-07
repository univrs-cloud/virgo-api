import DataService from '../../database/data_service.js';

const deleteShortcut = async (job, module) => {
	const { config } = job.data;
	const existingShortcut = await DataService.getShortcut(config?.name);
	if (!existingShortcut) {
		throw new Error(`Shortcut not found.`);
	}
	
	await module.updateJobProgress(job, `${existingShortcut.title} shortcut is deleting...`);
	await DataService.deleteShortcut(config.name);
	module.eventEmitter.emit('configured:updated');
	return `${existingShortcut.title} shortcut deleted.`;
};

const onConnection = (socket, module) => {
	socket.on('shortcut:delete', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('shortcut:delete', { config, username: socket.username });
	});
};

export default {
	name: 'delete',
	onConnection,
	jobs: {
		'shortcut:delete': deleteShortcut
	}
};
