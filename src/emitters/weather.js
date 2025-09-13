const fs = require('fs');
const touch = require('touch');
const BaseEmitter = require('./base');
const FileWatcher = require('../utils/file_watcher');

class WeatherEmitter extends BaseEmitter {
	#configurationWatcher;
	#configurationFile = '/var/www/virgo-api/configuration.json';
	#request = null;
	#fetchRetries = 3;
	#fetchDelay = 10000;

	constructor(io) {
		super(io, 'weather');
		this.#watchConfiguration();
		this.#scheduleWeatherFetcher();
	}

	onConnection(socket) {
		if (this.getState('weather')) {
			this.getNsp().emit('weather', this.getState('weather'));
		}
	}

	async processJob(job) {
		if (job.name === 'fetchWeather') {
			this.#fetchRetries = 3;
			return await this.#fetchWeather();
		}
	}

	#watchConfiguration() {
		const readFile = () => {
			let data = fs.readFileSync(this.#configurationFile, { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data === '') {
				this.setState(
					'configuration',
					{
						location: {
							latitude: '45.749',
							longitude: '21.227'
						}
					}
				);
			} else {
				this.setState('configuration', JSON.parse(data));
			}
			this.#fetchWeather();
		};

		if (this.#configurationWatcher) {
			return;
		}
	
		if (!fs.existsSync(this.#configurationFile)) {
			touch.sync(this.#configurationFile);
		}
	
		if (this.getState('configuration') === undefined) {
			this.setState('configuration', {});
			readFile();
		}
	
		this.#configurationWatcher = new FileWatcher(this.#configurationFile);
		this.#configurationWatcher
			.onChange((event, path) => {
				readFile();
			});
	}

	async #scheduleWeatherFetcher() {
		this.addJobSchedule(
			'fetchWeather',
			{ pattern: '0 1 * * * *' }
		);
	}	

	async #fetchWeather() {
		if (this.#request || this.getState('configuration') === undefined) {
			return;
		}
	
		let configuration = this.getState('configuration');
		const latitude = configuration.location.latitude;
		const longitude = configuration.location.longitude;
		let weather;
		try {
			this.#request = true;
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
			weather = false;
			this.#fetchRetries--;
		} finally {
			this.#request = null;
			if (weather === false && this.#fetchRetries >= 0) {
				console.log(`Retrying weather fetch in ${this.#fetchDelay}ms. Attempts remaining: ${this.#fetchRetries}`);
				setTimeout(() => {
					this.#fetchWeather();
				}, this.#fetchDelay);
				return;
			}
		}
		
		if (weather) {
			this.#fetchRetries = 3;
			this.setState('weather', weather);
			this.getNsp().emit('weather', this.getState('weather'));
		} else {
			console.error('Failed to fetch weather data after all retry attempts');
		}
		
		return ``;
	}
}

module.exports = (io) => {
	return new WeatherEmitter(io);
};
