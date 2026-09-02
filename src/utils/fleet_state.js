let runtimeState = {
	connected: false,
	authFailed: false
};

const getRuntimeState = () => {
	return { ...runtimeState };
};

const setRuntimeState = (updates) => {
	runtimeState = { ...runtimeState, ...updates };
};

const resetRuntimeState = () => {
	runtimeState = { connected: false, authFailed: false };
};

export {
	getRuntimeState,
	setRuntimeState,
	resetRuntimeState
};
