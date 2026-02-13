const BaseModule = require('../base');

class BookmarkModule extends BaseModule {
	#bookmarkIconsDir = '/messier/.config/assets/img/bookmarks';

	constructor() {
		super('bookmark');
	}

	get bookmarkIconsDir() {
		return this.#bookmarkIconsDir;
	}
}

module.exports = () => {
	return new BookmarkModule();
};
