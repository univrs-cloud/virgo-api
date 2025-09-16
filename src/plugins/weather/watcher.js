const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;

const watchConfiguration = (plugin) => {
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
                    }
                }
            );
        } else {
            plugin.setState('configuration', JSON.parse(data));
        }
        plugin.fetchWeather();
    };

    if (configurationWatcher) {
        return;
    }

    if (!fs.existsSync(plugin.configurationFile)) {
        touch.sync(plugin.configurationFile);
    }
    
    readFile();
    
    configurationWatcher = new FileWatcher(plugin.configurationFile);
    configurationWatcher
        .onChange((event, path) => {
            readFile();
        });
}

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchConfiguration(plugin);
	}
};
