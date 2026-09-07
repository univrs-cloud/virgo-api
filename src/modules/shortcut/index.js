import BaseModule from '../base.js';

class ShortcutModule extends BaseModule {
	#shortcutIconsDir = '/messier/.config/assets/img/shortcuts';

	constructor() {
		super('shortcut');
	}

	get shortcutIconsDir() {
		return this.#shortcutIconsDir;
	}
}

export default () => {
	return new ShortcutModule();
};
