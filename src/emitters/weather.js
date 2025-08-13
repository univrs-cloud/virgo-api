const fs = require('fs');
const touch = require('touch');
const chokidar = require('chokidar');
const { Queue, Worker } = require('bullmq');

let nsp;
let state = {};
let configurationWatcher;
let request = null;
let fetchRetries = 3;
const fetchDelay = 10000;
const configurationFile = '/var/www/virgo-api/configuration.json';
const queue = new Queue('weather-jobs');
const worker = new Worker(
	'weather-jobs',
	async (job) => {
		if (job.name === 'fetchWeather') {
			return await fetchWeather();
		}
	},
	{
		connection: {
			host: 'localhost',
			port: 6379,
		}
	}
);
worker.on('error', (error) => {
	console.error(error);
});

const scheduleWeatherFetcher = async () => {
	try {
		await queue.upsertJobScheduler(
			'weatherFetcher',
			{ pattern: '0 1 * * * *' },
			{
				name: 'fetchWeather',
				opts: {
					removeOnComplete: 1
				}
			}
		);
	} catch (error) {
		console.error('Error starting job:', error);
	};
};

const watchConfiguration = () => {
	if (configurationWatcher) {
		return;
	}

	touch.sync(configurationFile);

	if (state.configuration === undefined) {
		state.configuration = {};
		readFile();
	}

	configurationWatcher = chokidar.watch(configurationFile, {
		persistent: true,
		ignoreInitial: true
	});
	configurationWatcher
		.on('all', (event, path) => {
			readFile();
		})
		.on('error', (error) => {
			console.error(`Watcher error: ${error}`);
		});

	function readFile() {
		let data = fs.readFileSync(configurationFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data === '') {
			state.configuration = {
				location: {
					latitude: '45.749',
					longitude: '21.227'
				}
			};
		} else {
			state.configuration = JSON.parse(data);
		}
		fetchWeather();
	};
}

const fetchWeather = async () => {
	if (request || state.configuration === null) {
		return;
	}

	const latitude = state.configuration.location.latitude;
	const longitude = state.configuration.location.longitude;
	let weather;
	try {
		request = true;
		fetchRetries = 3;
		
		const controller = new AbortController();
		const timeoutId = setTimeout(() => { controller.abort(); }, 30000); // 30 second timeout
		const weatherResponse = await fetch(
			`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=sunrise,sunset&hourly=temperature_2m,precipitation_probability&current_weather=true&temperature_unit=celsius&timezone=auto`,
			{
				signal: controller.signal
			}
		);
		
		clearTimeout(timeoutId);
		
		if (!weatherResponse.ok) {
			throw new Error(`HTTP error! status: ${weatherResponse.status}`);
		}
		
		weather = await weatherResponse.json();
	} catch (error) {
		console.error('Weather fetch error:', error.message);
		if (error.name === 'AbortError') {
			console.error('Request timed out after 30 seconds');
		}
		fetchRetries--;
		weather = false;
	} finally {
		request = null;
		if (weather === false && fetchRetries > 0) {
			console.log(`Retrying weather fetch in ${fetchDelay}ms. Attempts remaining: ${fetchRetries}`);
			setTimeout(() => {
				fetchWeather();
			}, fetchDelay);
			return;
		}
	};
	
	if (weather) {
		state.weather = weather;
		nsp.emit('weather', state.weather);
	} else {
		console.error('Failed to fetch weather data after all retry attempts');
	}
	
	return ``;
};

scheduleWeatherFetcher();

module.exports = (io) => {
	nsp = io.of('/weather');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		if (state.weather) {
			nsp.emit('weather', state.weather);
		}

		socket.on('disconnect', () => {
			//
		});
	});

	watchConfiguration();
};
