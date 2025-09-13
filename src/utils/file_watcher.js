const fs = require('fs');
const chokidar = require('chokidar');

class FileWatcher {
	#watcher = null;
	#options = {
		persistent: true,
		ignoreInitial: true
	};
	#callbacks = [];
	#toWatch = [];

	constructor(toWatch, options = {}) {
		this.#toWatch = toWatch;
		this.#options = {
			...this.#options,
			...options
		};
		return this.start();
	}

	start() {
		if (this.#watcher) {
			return this;
		}

		this.#watcher = chokidar.watch(this.#toWatch, this.options);
		this.#watcher
			.on('all', (event, path) => {
				this.#triggerCallbacks(event, path);
			})
			.on('error', (error) => {
				console.error(`FileWatcher error: ${error}`);
			});
		return this;
	}

	async stop() {
		if (this.#watcher) {
			await this.#watcher.close();
			this.#watcher = null;
		}
		return this;
	}

	getWatched() {
		return this.#watcher.getWatched();
	}

	add(toWatch) {
		if (Array.isArray(toWatch)) {
			toWatch.forEach(item => {
				if (typeof item === 'string') {
					this.#toWatch.push(item);
					this.#watcher.add(item);
				} else {
					console.warn(`FileWatcher "${item}" is not a string and will be ignored.`);
				}
			});
		} else if (typeof toWatch === 'string') {
			this.#toWatch.push(toWatch);
			this.#watcher.add(toWatch);
		}
		return this;
	}

	remove(toUnwatch) {
		if (Array.isArray(toUnwatch)) {
			toUnwatch.forEach(item => {
				if (typeof item === 'string') {
					this.#toWatch = this.#toWatch.filter((existingItem) => { return existingItem !== item; });
					this.#watcher.unwatch(item);
				} else {
					console.warn(`FileWatcher "${item}" is not a string and will be ignored.`);
				}
			});
		} else if (typeof toUnwatch === 'string') {
			this.#toWatch = this.#toWatch.filter((existingItem) => { return existingItem !== toUnwatch; });
			this.#watcher.unwatch(toUnwatch);
		}
		return this;
	}

	/**
	 * Add a callback to be called when file changes
	 */
	onChange(callback) {
		if (typeof callback === 'function') {
			this.#callbacks.push(callback);
		}
		return this;
	}

	/**
	 * Remove a callback
	 */
	offChange(callback) {
		const index = this.#callbacks.indexOf(callback);
		if (index > -1) {
			this.#callbacks.splice(index, 1);
		}
		return this;
	}

	/**
	 * Trigger all callbacks
	 */
	#triggerCallbacks(event, path) {
		this.#callbacks.forEach(callback => {
			try {
				callback(event, path);
			} catch (error) {
				console.error(`FileWatcher callback error:`, error);
			}
		});
	}
}

module.exports = FileWatcher;
