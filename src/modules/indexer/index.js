const BaseModule = require('../base');

class IndexerModule extends BaseModule {
	constructor() {
		super('indexer');
	}
}

module.exports = () => {
	return new IndexerModule();
};
