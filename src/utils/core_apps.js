const CORE_APPS = ['authelia', 'traefik'];

const isCoreApp = (name) => {
	return CORE_APPS.includes(name);
};

export { CORE_APPS, isCoreApp };
