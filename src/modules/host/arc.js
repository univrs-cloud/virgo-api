import os from 'os';
import { promises as fs } from 'fs';

const ARC_MAX_FILE = '/sys/module/zfs/parameters/zfs_arc_max';
const ARCSTATS_FILE = '/proc/spl/kstat/zfs/arcstats';
const MODPROBE_FILE = '/etc/modprobe.d/zfs.conf';
const MIN_ARC_MAX = 64 * 1024 * 1024;
const ARC_MAX_OPTION = /^(options\s+zfs\s+.*\bzfs_arc_max=)\d+/m;

const loadArc = async (module) => {
	try {
		const arcstats = await fs.readFile(ARCSTATS_FILE, 'utf8');
		const readArcstat = (key) => {
			return Number(new RegExp(`^${key}\\s+\\d+\\s+(\\d+)$`, 'm').exec(arcstats)?.[1]);
		};
		module.setState('arc', {
			max: readArcstat('c_max'),
			min: Math.max(MIN_ARC_MAX, readArcstat('c_min') + 1),
			limit: Math.floor(os.totalmem() / 2)
		});
	} catch (error) {
		console.error('loadArc:', error);
		module.setState('arc', false);
	}
	module.emitState('arc');
};

const persistArcMax = async (max) => {
	let content = '';
	try {
		content = await fs.readFile(MODPROBE_FILE, 'utf8');
	} catch (error) {}

	if (ARC_MAX_OPTION.test(content)) {
		content = content.replace(ARC_MAX_OPTION, `$1${max}`);
	} else {
		content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}options zfs zfs_arc_max=${max}\n`;
	}
	await fs.writeFile(MODPROBE_FILE, content, 'utf8');
};

const updateArc = async (job, module) => {
	const max = Number(job.data.config?.max);
	const arc = module.getState('arc');
	if (!Number.isSafeInteger(max) || max < arc?.min || max > arc?.limit) {
		throw new Error('ZFS ARC maximum is out of range.');
	}

	await module.updateJobProgress(job, 'ZFS ARC maximum is updating...');
	await fs.writeFile(ARC_MAX_FILE, String(max), 'utf8');
	await persistArcMax(max);
	await loadArc(module);
	return 'ZFS ARC maximum updated.';
};

const register = (module) => {
	module.declareState({
		arc: { event: 'host:arc', audience: 'admin' }
	});
	loadArc(module);
};

export default {
	name: 'arc',
	register,
	commands: {
		'host:arc:update': { job: 'host:arc:update' }
	},
	jobs: {
		'host:arc:update': updateArc
	}
};
