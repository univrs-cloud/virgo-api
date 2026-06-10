import BaseModule from '../base.js';

class BookmarkModule extends BaseModule {
	#bookmarkIconsDir = '/messier/.config/assets/img/bookmarks';

	constructor() {
		super('bookmark');
	}

	get bookmarkIconsDir() {
		return this.#bookmarkIconsDir;
	}
}

export default () => {
	return new BookmarkModule();
};
