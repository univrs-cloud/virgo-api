let runtimeState = {
	connected: false,
	authFailed: false
};

const getFleetRuntimeState = () => {
	return { ...runtimeState };
};

const setFleetRuntimeState = (updates) => {
	runtimeState = { ...runtimeState, ...updates };
};

const resetFleetRuntimeState = () => {
	runtimeState = { connected: false, authFailed: false };
};

export {
	getFleetRuntimeState,
	setFleetRuntimeState,
	resetFleetRuntimeState
};
