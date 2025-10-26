class Poller {
	#CACHE_TTL = 1 * 60 * 1000; // 1 minute in ms
	#module;
	#callback;
	#interval;
	#isRunning = false;
	#idleTimeout = null;
	
	constructor(module, callback, interval) {
		this.#module = module;
		this.#callback = callback;
		this.#interval = interval;

		this.start();
	}

	start() {
		if (this.#isRunning) {
			return;
		}

		this.#isRunning = true;
		this.#loop();
	}

	#stop() {
		if (this.#idleTimeout) {
			clearTimeout(this.#idleTimeout);
		}
		this.#idleTimeout = null;
		this.#isRunning = false;
	}

	async #loop() {
		const hasClients = this.#module.getNsp().server.engine.clientsCount > 0;
		if (!hasClients) {
			if (this.#idleTimeout === null) {
				this.#idleTimeout = setTimeout(() => {
					this.#stop();
				}, this.#CACHE_TTL);
			}
		} else {
			if (this.#idleTimeout) {
				clearTimeout(this.#idleTimeout);
				this.#idleTimeout = null;
			}
		}

		try {
			await this.#callback(this.#module);
		} catch (error) {
			console.error(error);
		}

		if (this.#isRunning) {
			setTimeout(() => { this.#loop(); }, this.#interval);
		}
	}
}

module.exports = Poller;
