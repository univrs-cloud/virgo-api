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

export default {
	name: 'delete',
	commands: {
		'shortcut:delete': { job: 'shortcut:delete' }
	},
	jobs: {
		'shortcut:delete': deleteShortcut
	}
};
