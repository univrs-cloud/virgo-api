const BasePlugin = require('./base');
const DataService = require('../../database/data_service');

class WeatherPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'weather');
	}

	init() {
		this.request = null;
		this.fetchDelay = 10000;
		this.fetchRetries = 3;
		
		this.fetchWeather();

		this.getIo().on('configuration:location:updated', () => {
			this.fetchWeather();
		});
	}

	onConnection(socket) {
		if (this.getState('weather')) {
			this.getNsp().emit('weather', this.getState('weather'));
		}
	}

	async fetchWeather() {
		if (this.request) {
			return;
		}
	
		let configuration = await DataService.getConfiguration();
		if (!configuration || !configuration.location) {
			return;
		}
		
		const latitude = configuration.location.latitude;
		const longitude = configuration.location.longitude;
		let weather;
		try {
			this.request = true;
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
			this.fetchRetries--;
		} finally {
			this.request = null;
			if (weather === false && this.fetchRetries >= 0) {
				console.log(`Retrying weather fetch in ${this.fetchDelay}ms. Attempts remaining: ${this.fetchRetries}`);
				setTimeout(() => {
					this.fetchWeather();
				}, this.fetchDelay);
				return;
			}
		}
		
		if (weather) {
			this.fetchRetries = 3;
			this.setState('weather', weather);
			this.getNsp().emit('weather', this.getState('weather'));
		} else {
			console.error('Failed to fetch weather data after all retry attempts');
		}
		
		return ``;
	}
}

module.exports = (io) => {
	return new WeatherPlugin(io);
};
