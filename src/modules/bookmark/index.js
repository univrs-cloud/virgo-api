const BasePlugin = require('../base');

class BookmarkPlugin extends BasePlugin {
	constructor() {
		super('bookmark');
	}
}

module.exports = () => {
	return new BookmarkPlugin();
};
