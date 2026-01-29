const { execa } = require('execa');
const ini = require('ini');
const BaseModule = require('../base');

class ShareModule extends BaseModule {
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];
	#timeMachinesConf = '/messier/.shares/time_machines.conf';
	#timeMachinesDatasetPrefix = 'messier/time_machines';

	constructor() {
		super('share');

		(async () => {
			await this.#loadShares();
		})();

		this.eventEmitter
			.on('shares:updated', async () => {
				await this.#loadShares();
				this.nsp.emit('shares', this.getState('shares'));
			});
	}

	get configurationFiles() {
		return this.#configurationFiles;
	}

	get timeMachinesConf() {
		return this.#timeMachinesConf;
	}

	get timeMachinesDatasetPrefix() {
		return this.#timeMachinesDatasetPrefix;
	}

	onConnection(socket) {
		if (this.getState('shares')) {
			socket.emit('shares', this.getState('shares'));
		}
	}

	async #loadShares() {
		try {
			const response = await execa('testparm', ['-s', '-l']);
			const shares = ini.parse(response.stdout);
			delete shares.global;
			let promises = Object.entries(shares).map(async ([name, value]) => {
				let share = {
					name: name,
					comment: value['comment'],
					path: value['path'],
					validUsers: value['valid users']?.split(' '),
					size: 0,
					free: 0,
					alloc: 0,
					cap: 0,
					isPrivate: (value['guest ok']?.toLowerCase() !== 'yes'),
					isTimeMachine: (value['fruit:time machine'] === 'yes')
				};
				try {
					const { stdout: dfOutput } = await execa('df', ['-Pk', value['path']]);
					const parts = dfOutput.split('\n')[1].split(/\s+/);
					const size = parseInt(parts[1], 10) * 1024;
					const free = parseInt(parts[3], 10) * 1024;
					const mountpoint = parts[5];
					
					let used;
					if (value['path'] === mountpoint) {
						// Path is a ZFS mountpoint, use df
						used = parseInt(parts[2], 10) * 1024;
					} else {
						// Path is a subdirectory, use du for actual directory size
						const { stdout: duOutput } = await execa('du', ['-sb', '--apparent-size', value['path']]);
						used = parseInt(duOutput.split(/\s+/)[0], 10);
					}
					
					share.size = size;
					share.free = free;
					share.alloc = used;
					share.cap = (size > 0 ? used / size * 100 : 0);
				} catch (error) {
					console.error(`Error checking disk space for ${name}:`, error);
				}
				return share;
			});
			this.setState('shares', await Promise.all(promises));
		} catch (error) {
			this.setState('shares', false);
		}
	}
}

module.exports = () => {
	return new ShareModule();
};
