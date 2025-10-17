const fs = require('fs');
const { execa } = require('execa');
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;
const BasePlugin = require('../base');

class SharePlugin extends BasePlugin {
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];
	
	constructor() {
		super('share');
	}

	get configurationFiles() {
		return this.#configurationFiles;
	}

	onConnection(socket) {
		if (this.getState('shares')) {
			this.getNsp().emit('shares', this.getState('shares'));
		} else {
			this.emitShares();
		}
	}

	async emitShares() {
		const getShares = async () => {
			try {
				const response = await execa('testparm', ['-s', '-l']);
				const shares = ini.parse(response.stdout);
				delete shares.global;
				let promises = Object.entries(shares).map(async ([name, value]) => {
					let share = {
						name: name,
						comment: value['comment'],
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
		};
	
		await getShares();
		this.getNsp().emit('shares', this.getState('shares'));
	}
}

module.exports = () => {
	return new SharePlugin();
};
