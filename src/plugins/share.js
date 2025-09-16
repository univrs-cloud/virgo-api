const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;
const BasePlugin = require('./base');

class SharePlugin extends BasePlugin {
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];

	constructor(io) {
		super(io, 'share');
	}

	get configurationFiles() {
		return this.#configurationFiles;
	}

	set configurationFiles(files) {
		this.#configurationFiles = files;
	}

	onConnection(socket) {
		if (this.getState('shares')) {
			this.getNsp().emit('shares', this.getState('shares'));
		} else {
			this.emitShares();
		}
	}

	async handleShareAction(socket, action, config) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await this.addJob(action, { config, username: socket.username });
	}

	async emitShares() {
		const getShares = async () => {
			try {
				const response = await exec('testparm -s -l');
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
						share.cap = share.alloc / share.size * 100;
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

module.exports = (io) => {
	return new SharePlugin(io);
};
