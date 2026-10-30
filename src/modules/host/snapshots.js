import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';

const getSnapshots = async (module) => {
	try {
		const { stdout: zfsList } = await execa('zfs', ['list', '-t', 'snapshot', '-r', '-o', 'name,used,avail,refer,mountpoint,univrs:images', '-j', '--json-int']);
		const datasets = JSON.parse(zfsList || '{}')?.datasets || {};
		const snapshots = camelcaseKeys(datasets, { deep: true });
		module.setState('snapshots', snapshots);
	} catch (error) {
		console.error('getSnapshots:', error);
		module.setState('snapshots', false);
	}
	module.emitChanged('host:storage:snapshots', module.getState('snapshots'), { audience: 'admin' });
};

const register = (module) => {
	getSnapshots(module);
	module.eventEmitter.on('host:storage:snapshots:fetch', () => {
		getSnapshots(module);
	});
};

export default {
	name: 'snapshots',
	register
};
