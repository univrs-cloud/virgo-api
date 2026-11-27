const ACTIVE_STATES = new Set(['running', 'restarting', 'paused']);

const toArray = (value) => {
	return (Array.isArray(value) ? value : []);
};

const protocols = (protocol) => {
	return (String(protocol ?? '').toLowerCase() === 'both' ? ['tcp', 'udp'] : [String(protocol ?? '').toLowerCase()]);
};

const portKeys = (ports) => {
	return toArray(ports).flatMap((port) => {
		const [published, protocol] = (typeof port === 'string' ? port.split('/') : [port?.published, port?.protocol]);
		return protocols(protocol).map((value) => { return `${Number(published)}/${value}`; });
	});
};

const getContainerName = (container) => {
	return String(container.labels?.comDockerComposeProject || container.names?.[0]?.replace(/^\//, '') || container.id || '');
};

const getContainerPorts = (container) => {
	if (!ACTIVE_STATES.has(String(container.state ?? '').toLowerCase())) {
		return [];
	}

	return toArray(container.ports)
		.filter((port) => { return port.publicPort; })
		.map((port) => { return `${Number(port.publicPort)}/${String(port.type).toLowerCase()}`; });
};

const getActivePorts = (containers, exceptAppName) => {
	const except = String(exceptAppName ?? '').toLowerCase();
	return new Set(toArray(containers).flatMap((container) => {
		return (getContainerName(container).toLowerCase() === except ? [] : getContainerPorts(container));
	}));
};

const getPortConflicts = (requiredPorts, containers, apps, exceptAppName) => {
	const required = new Set(portKeys(requiredPorts));
	const conflicts = new Map();
	for (const container of toArray(containers)) {
		const name = getContainerName(container);
		if (name.toLowerCase() === String(exceptAppName ?? '').toLowerCase()) {
			continue;
		}

		const ports = getContainerPorts(container).filter((port) => { return required.has(port); });
		if (ports.length === 0) {
			continue;
		}

		const key = name.toLowerCase();
		if (!conflicts.has(key)) {
			const app = toArray(apps).find((entry) => { return String(entry.name).toLowerCase() === key; });
			conflicts.set(key, { name, title: app?.title || name, ports: new Set() });
		}
		for (const port of ports) {
			conflicts.get(key).ports.add(port);
		}
	}
	return [...conflicts.values()].map((conflict) => { return { ...conflict, ports: [...conflict.ports] }; });
};

const formatPortConflicts = (conflicts, action) => {
	return conflicts.map(({ title, ports }) => {
		const portList = ports.join(', ');
		return `${ports.length === 1 ? 'Port' : 'Ports'} ${portList} ${ports.length === 1 ? 'is' : 'are'} in use by ${title}. Stop ${title} before ${action}.`;
	}).join(' ');
};

export { getActivePorts, getPortConflicts, formatPortConflicts };
