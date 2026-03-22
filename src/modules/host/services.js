const { execa } = require('execa');

const loadServices = async (module) => {
	try {
		const [{ stdout: serviceUnitsList }, { stdout: serviceUnitFilesList }] = await Promise.all([
			execa('systemctl', ['list-units', '--type=service,target,socket,timer,path', '--all', '--output=json']),
			execa('systemctl', ['list-unit-files', '--type=service,target,socket,timer,path', '--output=json'])
		]);
		const serviceUnits = JSON.parse(serviceUnitsList);
		const serviceUnitFiles = JSON.parse(serviceUnitFilesList);
		const loadedUnitNames = new Set(serviceUnits.map((unit) => { return unit.unit; }));
		const totalMemory = module.getState('memory')?.total;

		// template unit files (e.g. foo@.service) are not useful without an instance
		const isTemplate = (name) => { return /@[^.]*\./.test(name) || name.endsWith('@'); };
		const unloadedUnitFiles = serviceUnitFiles.filter((unitFile) => {
			const name = unitFile.unit_file.split('/').pop();
			return !loadedUnitNames.has(name) && !isTemplate(name);
		});

		const activeServiceUnits = serviceUnits.filter((unit) => { return unit.active === 'active' && unit.unit.endsWith('.service'); }).map((unit) => { return unit.unit; });
		const unloadedUnitNames = unloadedUnitFiles.map((unitFile) => { return unitFile.unit_file.split('/').pop(); });
		const showUnits = [...activeServiceUnits, ...unloadedUnitNames];

		const memoryMap = new Map();
		const descriptionMap = new Map();
		if (showUnits.length > 0) {
			const { stdout } = await execa('systemctl', ['show', ...showUnits, '--property=Id,MemoryCurrent,Description']);
			let currentId = null;
			let currentMemory = undefined;
			let currentDescription = undefined;
			for (const line of stdout.split('\n')) {
				if (line.startsWith('Id=')) {
					currentId = line.slice(3);
				} else if (line.startsWith('MemoryCurrent=')) {
					const value = line.slice(14);
					currentMemory = /^\d+$/.test(value) ? parseInt(value, 10) : null;
				} else if (line.startsWith('Description=')) {
					currentDescription = line.slice(12);
				} else if (line === '' && currentId) {
					if (currentMemory !== undefined) memoryMap.set(currentId, currentMemory);
					if (currentDescription !== undefined) descriptionMap.set(currentId, currentDescription);
					currentId = null;
					currentMemory = undefined;
					currentDescription = undefined;
				}
			}
			if (currentId) {
				if (currentMemory !== undefined) memoryMap.set(currentId, currentMemory);
				if (currentDescription !== undefined) descriptionMap.set(currentId, currentDescription);
			}
		}

		const services = serviceUnits.map((service) => {
			const templateName = service.unit.replace(/@[^.]+(\.[^.]+)$/, '@$1');
			const serviceUnitFile = serviceUnitFiles.find((serviceUnitFile) => { return serviceUnitFile.unit_file === service.unit; }) || serviceUnitFiles.find((serviceUnitFile) => { return serviceUnitFile.unit_file === templateName; });
			service.type = service.unit.split('.').pop();
			service.unitFileState = serviceUnitFile?.state || 'unknown';
			service.broken = (service.load === 'not-found' || service.load === 'error');
			const memoryUsage = memoryMap.get(service.unit) || 0;
			service.memory = {
				usage: memoryUsage,
				percent: totalMemory ? (memoryUsage / totalMemory) * 100 : 0
			};
			return service;
		});

		for (const unitFile of unloadedUnitFiles) {
			const name = unitFile.unit_file.split('/').pop();
			services.push({
				unit: name,
				load: 'not-loaded',
				active: 'inactive',
				sub: 'dead',
				description: descriptionMap.get(name) || '',
				type: name.split('.').pop(),
				unitFileState: unitFile.state,
				broken: false,
				memory: { usage: 0, percent: 0 },
			});
		}

		module.setState('services', services);
	} catch (error) {

	}
};

const unitType = (serviceName) => { return serviceName.split('.').pop(); };

const broadcastServices = async (module) => {
	await loadServices(module);
	for (const socket of module.nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('host:system:services', module.getState('services'));
		}
	}
};

const enableService = async (job, module) => {
	const { config } = job.data;
	const actionVerbs = module.nlp.conjugate('enable');
	await module.updateJobProgress(job, `${config.unit} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['enable', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} ${actionVerbs.pastTense}.`;
};

const enableStartService = async (job, module) => {
	const { config } = job.data;
	if (unitType(config.unit) === 'target') {
		throw new Error(`Cannot start a target unit.`);
	}

	const services = module.getState('services');
	const service = services?.find((service) => { return service.unit === config.unit; });
	if (service?.broken) {
		throw new Error(`Unit file not found for ${config.unit}.`);
	}

	await module.updateJobProgress(job, `${config.unit} is enabling and starting...`);
	await execa('systemctl', ['enable', '--now', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} enabled and started.`;
};

const disableService = async (job, module) => {
	const { config } = job.data;
	const actionVerbs = module.nlp.conjugate('disable');
	await module.updateJobProgress(job, `${config.unit} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['disable', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} ${actionVerbs.pastTense}.`;
};

const disableStopService = async (job, module) => {
	const { config } = job.data;
	if (unitType(config.unit) === 'target') {
		throw new Error(`Cannot stop a target unit.`);
	}

	const services = module.getState('services');
	const service = services?.find((service) => { return service.unit === config.unit; });
	if (service?.broken) {
		throw new Error(`Unit file not found for ${config.unit}.`);
	}

	await module.updateJobProgress(job, `${config.unit} is disabling and stopping...`);
	await execa('systemctl', ['disable', '--now', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} disabled and stopped.`;
};

const startService = async (job, module) => {
	const { config } = job.data;
	if (unitType(config.unit) === 'target') {
		throw new Error(`Cannot start a target unit.`);
	}

	const services = module.getState('services');
	const service = services?.find((service) => { return service.unit === config.unit; });
	if (service?.broken) {
		throw new Error(`Unit file not found for ${config.unit}.`);
	}

	const actionVerbs = module.nlp.conjugate('start');
	await module.updateJobProgress(job, `${config.unit} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['start', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} ${actionVerbs.pastTense}.`;
};

const stopService = async (job, module) => {
	const { config } = job.data;
	if (unitType(config.unit) === 'target') {
		throw new Error(`Cannot stop a target unit.`);
	}

	const services = module.getState('services');
	const service = services?.find((service) => { return service.unit === config.unit; });
	if (service?.broken) {
		throw new Error(`Unit file not found for ${config.unit}.`);
	}

	const actionVerbs = module.nlp.conjugate('stop');
	await module.updateJobProgress(job, `${config.unit} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['stop', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} ${actionVerbs.pastTense}.`;
};

const restartService = async (job, module) => {
	const { config } = job.data;
	if (unitType(config.unit) === 'target') {
		throw new Error(`Cannot restart a target unit.`);
	}

	const services = module.getState('services');
	const service = services?.find((service) => { return service.unit === config.unit; });
	if (service?.broken) {
		throw new Error(`Unit file not found for ${config.unit}.`);
	}

	const actionVerbs = module.nlp.conjugate('restart');
	await module.updateJobProgress(job, `${config.unit} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['restart', config.unit]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.unit} ${actionVerbs.pastTense}.`;
};

const register = (module) => {
	loadServices(module);

	module.eventEmitter
		.on('host:system:services:updated', async () => {
			await broadcastServices(module);
		});
};

const onConnection = (socket, module) => {
	if (socket.isAuthenticated && socket.isAdmin) {
		if (module.getState('services')) {
			socket.emit('host:system:services', module.getState('services'));
		}
	}

	socket.on('host:system:services:fetch', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await broadcastServices(module);
	});

	socket.on('host:system:service:enable', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:enable', { config, username: socket.username });
	});

	socket.on('host:system:service:enable-start', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:enable-start', { config, username: socket.username });
	});

	socket.on('host:system:service:disable', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:disable', { config, username: socket.username });
	});

	socket.on('host:system:service:disable-stop', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:disable-stop', { config, username: socket.username });
	});

	socket.on('host:system:service:start', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:start', { config, username: socket.username });
	});

	socket.on('host:system:service:stop', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:stop', { config, username: socket.username });
	});

	socket.on('host:system:service:restart', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('host:system:service:restart', { config, username: socket.username });
	});
};

module.exports = {
	name: 'services',
	register,
	onConnection,
	jobs: {
		'host:system:service:enable': enableService,
		'host:system:service:enable-start': enableStartService,
		'host:system:service:disable': disableService,
		'host:system:service:disable-stop': disableStopService,
		'host:system:service:start': startService,
		'host:system:service:stop': stopService,
		'host:system:service:restart': restartService
	}
};
