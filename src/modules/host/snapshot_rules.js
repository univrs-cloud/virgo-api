import * as sanoid from '../../utils/sanoid.js';

const loadRules = async (module) => {
	try {
		module.setState('snapshotRules', await sanoid.getRules());
	} catch (error) {
		console.error('loadRules:', error);
		module.setState('snapshotRules', false);
	}
	module.emitChanged('host:snapshotRules', module.getState('snapshotRules'), { audience: 'admin' });
};

const announceChange = (module) => {
	module.eventEmitter.emit('configured:updated');
	module.eventEmitter.emit('shares:updated');
};

const createRule = async (job, module) => {
	const { rule } = job.data.config;
	await module.updateJobProgress(job, `Creating snapshot rule ${rule?.name}...`);
	await sanoid.saveRule(null, rule);
	announceChange(module);
	return `Snapshot rule ${rule.name} created.`;
};

const updateRule = async (job, module) => {
	const { name, rule } = job.data.config;
	await module.updateJobProgress(job, `Updating snapshot rule ${name}...`);
	await sanoid.saveRule(name, rule);
	announceChange(module);
	return `Snapshot rule ${rule.name} updated.`;
};

const deleteRule = async (job, module) => {
	const { name } = job.data.config;
	await module.updateJobProgress(job, `Deleting snapshot rule ${name}...`);
	await sanoid.deleteRule(name);
	announceChange(module);
	return `Snapshot rule ${name} deleted.`;
};

const register = (module) => {
	loadRules(module);
	module.eventEmitter
		.on('configured:updated', () => {
			loadRules(module);
		})
		.on('shares:updated', () => {
			loadRules(module);
		});
};

export default {
	name: 'snapshot_rules',
	register,
	commands: {
		'host:snapshotRules:create': { job: 'host:snapshotRules:create' },
		'host:snapshotRules:update': { job: 'host:snapshotRules:update' },
		'host:snapshotRules:delete': { job: 'host:snapshotRules:delete' }
	},
	jobs: {
		'host:snapshotRules:create': createRule,
		'host:snapshotRules:update': updateRule,
		'host:snapshotRules:delete': deleteRule
	}
};
