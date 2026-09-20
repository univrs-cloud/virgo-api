import DataService from '../../database/data_service.js';

const updateLocation = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `Saving location...`);	
	await DataService.setConfiguration('location', config);
	module.eventEmitter.emit('configuration:updated');
	module.eventEmitter.emit('configuration:location:updated');
	return `Location saved.`;
};

export default {
	name: 'location',
	commands: {
		'configuration:location:update': { job: 'location:update' }
	},
	jobs: {
		'location:update': updateLocation
	}
};
