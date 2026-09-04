const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_LOW_WATER_MARK = 256 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Bounded, ordered writer around node-datachannel's native send buffer. */
class DataChannelSendQueue {
	#channel;
	#queue = [];
	#queuedBytes = 0;
	#closed = false;
	#draining = false;
	#retryTimer = null;
	#drainWaiters = [];
	#highWaterMark;
	#lowWaterMark;
	#maxBufferedBytes;
	#onFailure;

	constructor(channel, {
		highWaterMark = DEFAULT_HIGH_WATER_MARK,
		lowWaterMark = DEFAULT_LOW_WATER_MARK,
		maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
		onFailure = () => {}
	} = {}) {
		this.#channel = channel;
		this.#highWaterMark = highWaterMark;
		this.#lowWaterMark = lowWaterMark;
		this.#maxBufferedBytes = maxBufferedBytes;
		this.#onFailure = onFailure;
		channel.setBufferedAmountLowThreshold(lowWaterMark);
		channel.onBufferedAmountLow(() => { this.#drain(); });
	}

	enqueue(buffer) {
		return this.enqueueMany([buffer]);
	}

	enqueueMany(buffers) {
		if (this.#closed || !this.#isOpen()) {
			return false;
		}
		const additions = buffers.map((buffer) => {
			return { buffer, length: buffer?.byteLength ?? buffer?.length ?? 0 };
		});
		const addedBytes = additions.reduce((total, entry) => { return total + entry.length; }, 0);
		if (this.#bufferedAmount() + this.#queuedBytes + addedBytes > this.#maxBufferedBytes) {
			this.#fail(new Error('WebRTC send queue exceeded its memory limit'));
			return false;
		}
		this.#queue.push(...additions);
		this.#queuedBytes += addedBytes;
		this.#drain();
		return true;
	}

	whenDrained() {
		if (this.#closed || !this.#isOpen()) {
			return Promise.reject(new Error('WebRTC data channel is closed'));
		}
		if (this.#queuedBytes + this.#bufferedAmount() <= this.#lowWaterMark) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			this.#drainWaiters.push({ resolve, reject });
		});
	}

	#settleDrainWaiters() {
		if (!this.#drainWaiters.length) {
			return;
		}
		if (this.#queuedBytes + this.#bufferedAmount() > this.#lowWaterMark) {
			return;
		}
		const waiters = this.#drainWaiters;
		this.#drainWaiters = [];
		waiters.forEach((waiter) => { waiter.resolve(); });
	}

	#isOpen() {
		try {
			return Boolean(this.#channel?.isOpen());
		} catch (error) {
			return false;
		}
	}

	#bufferedAmount() {
		try {
			return Number(this.#channel?.bufferedAmount()) || 0;
		} catch (error) {
			return 0;
		}
	}

	#drain() {
		if (this.#closed || this.#draining || !this.#isOpen()) {
			return;
		}
		this.#draining = true;
		try {
			while (this.#queue.length && this.#bufferedAmount() < this.#highWaterMark) {
				const entry = this.#queue[0];
				if (!this.#channel.sendMessageBinary(entry.buffer)) {
					this.#scheduleRetry();
					break;
				}
				this.#queue.shift();
				this.#queuedBytes -= entry.length;
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#draining = false;
		}
		this.#settleDrainWaiters();
	}

	#scheduleRetry() {
		if (this.#retryTimer || this.#closed) {
			return;
		}
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			if (!this.#isOpen()) {
				this.#fail(new Error('WebRTC data channel closed while sending'));
				return;
			}
			this.#drain();
		}, 10);
		this.#retryTimer.unref?.();
	}

	#fail(error) {
		if (this.#closed) {
			return;
		}
		this.close();
		this.#onFailure(error);
	}

	close() {
		this.#closed = true;
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}
		this.#queue = [];
		this.#queuedBytes = 0;
		const waiters = this.#drainWaiters;
		this.#drainWaiters = [];
		waiters.forEach((waiter) => { waiter.reject(new Error('WebRTC data channel is closed')); });
	}
}

export default DataChannelSendQueue;
export {
	DEFAULT_HIGH_WATER_MARK,
	DEFAULT_LOW_WATER_MARK,
	DEFAULT_MAX_BUFFERED_BYTES
};
