const normalize = (value) => {
	return String(value || '').trim().toLowerCase();
};

export {
	normalize
};
