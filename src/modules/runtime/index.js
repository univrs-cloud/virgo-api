import BaseModule from '../base.js';

class RuntimeModule extends BaseModule {
	constructor() {
		super('runtime');
	}

	onConnection(socket) {
		socket.emit('runtime', { role: 'node' });
	}
}

export default () => {
	return new RuntimeModule();
};
