const normalizeEmail = (value) => {
	return String(value || '').trim().toLowerCase();
};

export {
	normalizeEmail
};
