const BaseModule = require('../base');

class BookmarkModule extends BaseModule {
	#bookmarkIconsDir = '/var/www/virgo-ui/app/dist/assets/img/bookmarks';

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
