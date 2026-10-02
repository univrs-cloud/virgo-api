import BaseModule from '../base.js';

class IndexerModule extends BaseModule {
	constructor() {
		super('indexer');
	}
}

export default () => {
	return new IndexerModule();
};
