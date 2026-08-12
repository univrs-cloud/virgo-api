import * as setup from '../../utils/setup_state.js';

const onConnection = (socket, module) => {
	socket.on('host:setup:complete', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		if (setup.isCompleted()) {
			return;
		}

		// Writing the file is what ends setup mode: the watcher reports the new state to every client
		// and each socket loses the privileges it only held while setup was pending.
		await setup.complete();
	});
};

export default {
	name: 'setup',
	onConnection
};
