const fs = require('fs');
const { execa } = require('execa');
const ini = require('ini');
const BaseModule = require('../base');

class ShareModule extends BaseModule {
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];
	
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
					const [{ stdout: dfResult }, { stdout: duResult }] = await Promise.all([
						execa('df', ['-Pk', value['path']]),
						execa('du', ['-shb', '--apparent-size', value['path']])
					]);
					
					const dfLines = dfResult.split('\n');
					const dfParts = dfLines[1].split(/\s+/);
					const size = parseInt(dfParts[1], 10) * 1024;
					const free = parseInt(dfParts[3], 10) * 1024;
					
					const duParts = duResult.split(/\s+/);
					const used = parseInt(duParts[0], 10);
					
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
