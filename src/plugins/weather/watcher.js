const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;
let configurationFile = '/var/www/virgo-api/configuration.json';

const watchConfiguration = (plugin) => {
    const readFile = () => {
        let data = fs.readFileSync(configurationFile, { encoding: 'utf8', flag: 'r' });
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

    if (!fs.existsSync(configurationFile)) {
        touch.sync(configurationFile);
    }
    
    readFile();
    
    configurationWatcher = new FileWatcher(configurationFile);
    configurationWatcher
        .onChange((event, path) => {
            readFile();
        });
}

module.exports = {
	register(plugin) {
		watchConfiguration(plugin);
	}
};
