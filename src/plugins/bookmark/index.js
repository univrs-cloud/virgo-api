const BasePlugin = require('../base');

class BookmarkPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'bookmark');
	}
}

module.exports = (io) => {
	return new BookmarkPlugin(io);
};
