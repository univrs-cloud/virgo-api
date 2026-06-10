import FileWatcher from '../../utils/file_watcher.js';
import * as database from '../../../indexer/db.js';

// The indexer keeps SQLite in WAL mode, so the main `index.db` file is only
// touched on checkpoint (typically at the end of a run). That makes it the
// right signal to listen on: one event per finished run, not one per row
// written. We still debounce so that a checkpoint that arrives in several
// bursts only triggers a single emit.
const EMIT_DEBOUNCE_MS = 5000;

let indexDbWatcher;
let debounceTimer;

const watchIndexDb = (module) => {
	if (indexDbWatcher) {
		return indexDbWatcher;
	}

	indexDbWatcher = new FileWatcher(database.INDEX_DB_PATH);
	indexDbWatcher
		.onChange((event, changedPath) => {
			if (changedPath !== INDEX_DB_PATH) {
				return;
			}
			
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				module.eventEmitter.emit('indexer:index:updated');
			}, EMIT_DEBOUNCE_MS);
		})
		.onStop(() => {
			indexDbWatcher = null;
		});

	return indexDbWatcher;
};

const register = (module) => {
	watchIndexDb(module);
};

export default {
	name: 'watcher',
	register
};
