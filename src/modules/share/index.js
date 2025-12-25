const fs = require('fs');
const { execa } = require('execa');
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;
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
					const diskSpace = await checkDiskSpace(value['path']);
					share.size = diskSpace.size;
					share.free = diskSpace.free;
					share.alloc = share.size - share.free;
					share.cap = (share.size > 0 ? share.alloc / share.size * 100 : 0);
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
