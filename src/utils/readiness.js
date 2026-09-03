import * as setup from './setup_state.js';
import * as authelia from './authelia.js';

const AUTHELIA_GRACE = 300000;
const STARTED_AT = Date.now();

const isStarting = async () => {
	if (!setup.isCompleted()) {
		return false;
	}

	if ((Date.now() - STARTED_AT) >= AUTHELIA_GRACE) {
		return false;
	}

	return !(await authelia.isReady());
};

export {
	isStarting
};
