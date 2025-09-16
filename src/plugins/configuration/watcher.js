const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

module.exports = {
	register(plugin) {
		const readFile = () => {
			let data = fs.readFileSync(plugin.configurationFile, { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data === '') {
				plugin.setState(
					'configuration',
					{
						location: {
							latitude: '45.749',
							longitude: '21.227'
						},
						smtp: null
					}
				);
			} else {
				plugin.setState('configuration', JSON.parse(data));
			}
			let configuration = { ...plugin.getState('configuration') };
			for (const socket of plugin.getNsp().sockets.values()) {
				if (!socket.isAuthenticated || !socket.isAdmin) {
					delete configuration.smtp;
				}
				plugin.getNsp().to(`user:${socket.username}`).emit('configuration', configuration);
			}
		};
		
		if (!fs.existsSync(plugin.configurationFile)) {
			touch.sync(plugin.configurationFile);
		}
		
		readFile();
	
		const configurationWatcher = new FileWatcher(plugin.configurationFile);
		configurationWatcher
			.onChange((event, path) => {
				readFile();
			});
	}
};
