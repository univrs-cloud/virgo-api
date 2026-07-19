// Terminal progress rendering for the crawl/diff batch loops. On a TTY we draw
// a single animated line; on non-TTY (logs, CI) we emit one line per batch.

let _progressAnimTick = 0;

function indeterminateBar(width, tick) {
	const blockLen = Math.max(3, Math.floor(width / 4));
	const range = Math.max(1, width - blockLen + 1);
	const start = tick % range;
	let s = '';
	for (let i = 0; i < width; i++) {
		s += i >= start && i < start + blockLen ? '█' : '░';
	}
	return s;
}

export function logBatchProgress(unit, batchLen, total, t0) {
	const elapsedSec = (Date.now() - t0) / 1000;
	const rate = elapsedSec > 0 ? (total / elapsedSec).toFixed(0) : '0';
	_progressAnimTick++;
	if (process.stdout.isTTY) {
		const bar = indeterminateBar(22, _progressAnimTick);
		process.stdout.write(`\r    [${bar}] ${total.toLocaleString()} ${unit}  ${rate}/s\x1b[K`);
	} else {
		console.log(`    +${batchLen.toLocaleString()} ${unit} → ${total.toLocaleString()} total (${rate}/s)`);
	}
}

export function endProgressLine() {
	if (process.stdout.isTTY) {
		process.stdout.write('\n');
	}
}
