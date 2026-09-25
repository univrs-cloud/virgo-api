const CORE_APPS = { wetty: 'Terminal', authelia: 'Authelia', traefik: 'Traefik' };

const getCoreApps = () => {
	return Object.keys(CORE_APPS);
};

const isCoreApp = (name) => {
	return Object.hasOwn(CORE_APPS, name);
};

const getCoreAppTitle = (name) => {
	return CORE_APPS[name] || name;
};

export { getCoreApps, isCoreApp, getCoreAppTitle };
