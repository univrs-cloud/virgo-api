const BaseModule = require('../base');

class BookmarkModule extends BaseModule {
	constructor() {
		super('bookmark');
	}
}

module.exports = () => {
	return new BookmarkModule();
};
