const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;

const watchConfiguration = async (plugin) => {
    const readFile = async () => {
        let data = await fs.promises.readFile(plugin.configurationFile, { encoding: 'utf8', flag: 'r' });
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
			try {
				let configuration = JSON.parse(data);
				plugin.setState('configuration', configuration);
			} catch (error) {
				plugin.setState('configuration', false);
			}
        }
        plugin.fetchWeather();
    };

    if (configurationWatcher) {
        return;
    }

	try {
		await fs.promises.access(plugin.configurationFile);
	} catch (error) {
		await touch(plugin.configurationFile);
	}
    
    await readFile();
    
    configurationWatcher = new FileWatcher(plugin.configurationFile);
    configurationWatcher
        .onChange(async (event, path) => {
            await readFile();
        });
}

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchConfiguration(plugin);
	}
};
