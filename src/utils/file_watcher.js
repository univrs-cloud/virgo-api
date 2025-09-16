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
		this.#toWatch = (Array.isArray(toWatch) ? toWatch : [toWatch]);
		this.#options = {
			...this.#options,
			...options
		};
		this.start();
	}

	start() {
		if (this.#watcher) {
			return this;
		}

		this.#watcher = chokidar.watch(this.#toWatch, this.#options);
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
		if (!this.#watcher) {
			return {};
		}

		return this.#watcher.getWatched();
	}

	add(toWatch) {
		const items = (Array.isArray(toWatch) ? toWatch : [toWatch]);
		items.forEach(item => {
			if (typeof item === 'string') {
				this.#toWatch.push(item);
				this.#watcher?.add(item);
			} else {
				console.warn(`FileWatcher "${item}" is not a string and will be ignored.`);
			}
		});
		return this;
	}

	remove(toUnwatch) {
		const items = (Array.isArray(toUnwatch) ? toUnwatch : [toUnwatch]);
		items.forEach(item => {
			if (typeof item === 'string') {
				this.#toWatch = this.#toWatch.filter((existingItem) => { return existingItem !== item; });
				this.#watcher?.unwatch(item);
			} else {
				console.warn(`FileWatcher "${item}" is not a string and will be ignored.`);
			}
		});
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
