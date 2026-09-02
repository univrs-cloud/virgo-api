const CORE_APPS = ['authelia', 'traefik'];

/** A copy, so a caller cannot reshape the list every other caller reads. */
const getCoreApps = () => {
	return [...CORE_APPS];
};

const isCoreApp = (name) => {
	return CORE_APPS.includes(name);
};

export { getCoreApps, isCoreApp };
