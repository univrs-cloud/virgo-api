class Poller {
	#CACHE_TTL = 1 * 60 * 1000; // 1 minute in ms
	#module;
	#callback;
	#interval;
	#audience;
	#name;
	#idleTtl;
	#keepAlive;
	#aligned;
	#isRunning = false;
	#idleTimeout = null;
	#pollingTimeout = null;
	#generation = 0;

	constructor(module, callback, interval, { audience = 'any', idleTtl, name, keepAlive = false, aligned = false } = {}) {
		this.#module = module;
		this.#callback = callback;
		this.#interval = interval;
		this.#audience = audience;
		this.#name = name;
		this.#idleTtl = idleTtl ?? this.#CACHE_TTL;
		this.#keepAlive = keepAlive;
		this.#aligned = aligned;

		this.start();
	}

	get audience() {
		return this.#audience;
	}

	get name() {
		return this.#name;
	}

	get isRunning() {
		return this.#isRunning;
	}

	start() {
		clearTimeout(this.#idleTimeout);
		this.#idleTimeout = null;
		if (this.#isRunning) {
			return;
		}

		this.#isRunning = true;
		this.#generation++;
		this.#loop(this.#generation);
	}

	stop() {
		this.#stop();
	}

	#stop() {
		this.#generation++;
		this.#isRunning = false;
		clearTimeout(this.#idleTimeout);
		this.#idleTimeout = null;
		clearTimeout(this.#pollingTimeout);
		this.#pollingTimeout = null;
	}

	async #loop(generation) {
		if (generation !== this.#generation) {
			return;
		}

		const hasClients = this.#keepAlive || this.#module.hasAudience(this.#audience);
		if (!hasClients) {
			if (this.#idleTimeout === null) {
				this.#idleTimeout = setTimeout(() => {
					this.#idleTimeout = null;
					if (this.#module.hasAudience(this.#audience)) {
						return;
					}

					this.#stop();
				}, this.#idleTtl);
			}
		} else {
			if (this.#idleTimeout !== null) {
				clearTimeout(this.#idleTimeout);
				this.#idleTimeout = null;
			}
		}

		try {
			await this.#callback(this.#module);
		} catch (error) {
			console.error(error);
		}

		if (this.#isRunning && generation === this.#generation) {
			const delay = (this.#aligned ? this.#interval - (Date.now() % this.#interval) : this.#interval);
			this.#pollingTimeout = setTimeout(() => { this.#loop(generation); }, delay);
		}
	}
}

export default Poller;
