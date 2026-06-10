import { execa } from 'execa';

const applyProjectspace = async (job, module) => {
	const { sharePath, comment } = job.data;
	if (!sharePath) {
		throw new Error('sharePath is required.');
	}
	const label = comment || sharePath;
	const existing = await module.getPathProjectspace(sharePath);
	if (existing !== null) {
		return `${label} already tagged with projectspace ${existing}.`;
	}
	const projectspace = module.generateProjectspace(sharePath);
	await module.updateJobProgress(job, `Tagging ${label} with projectspace ${projectspace}...`);
	await execa('zfs', ['project', '-s', '-r', '-p', String(projectspace), sharePath]);
	module.eventEmitter.emit('shares:updated');
	return `Tagged ${label} with projectspace ${projectspace}.`;
};

const removeProjectspace = async (job, module) => {
	const { sharePath, comment } = job.data;
	if (!sharePath) {
		throw new Error('sharePath is required.');
	}
	const label = comment || sharePath;
	const existing = await module.getPathProjectspace(sharePath);
	if (existing === null) {
		return `${label} has no projectspace to remove.`;
	}
	await module.updateJobProgress(job, `Removing projectspace from ${label}...`);
	await execa('zfs', ['project', '-C', '-r', sharePath]);
	module.eventEmitter.emit('shares:updated');
	return `Removed projectspace from ${label}.`;
};

export default {
	name: 'projectspace',
	jobs: {
		'share:projectspace:apply': applyProjectspace,
		'share:projectspace:remove': removeProjectspace
	}
};
