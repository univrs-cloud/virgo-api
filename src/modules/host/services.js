const { execa } = require('execa');

const loadServices = async (module) => {
	try {
		const [{ stdout: serviceUnitsList }, { stdout: serviceUnitFilesList }] = await Promise.all([
			execa('systemctl', ['list-units', '--type=service', '--all', '--output=json']),
			execa('systemctl', ['list-unit-files', '--type=service', '--output=json'])
		]);
		const serviceUnits = JSON.parse(serviceUnitsList);
		const serviceUnitFiles = JSON.parse(serviceUnitFilesList);
		const activeServiceUnits = serviceUnits.filter((serviceUnit) => { return serviceUnit.active === 'active'; }).map((serviceUnit) => { return serviceUnit.unit; });
		const memoryMap = new Map();
		if (activeServiceUnits.length > 0) {
			const { stdout } = await execa('systemctl', ['show', ...activeServiceUnits, '--property=Id,MemoryCurrent']);
			let currentId = null;
			let currentMemory = undefined;
			for (const line of stdout.split('\n')) {
				if (line.startsWith('Id=')) {
					currentId = line.slice(3);
				} else if (line.startsWith('MemoryCurrent=')) {
					const value = line.slice(14);
					currentMemory = /^\d+$/.test(value) ? parseInt(value, 10) : null;
				} else if (line === '' && currentId !== null && currentMemory !== undefined) {
					memoryMap.set(currentId, currentMemory);
					currentId = null;
					currentMemory = undefined;
				}
			}
			// Handle last service (no trailing blank line)
			if (currentId !== null && currentMemory !== undefined) {
				memoryMap.set(currentId, currentMemory);
			}
		}

		const services = serviceUnits.map((service) => {
			const serviceUnitFile = serviceUnitFiles.find((serviceUnitFile) => { return serviceUnitFile.unit_file === service.unit; });
			service.unitFileState = serviceUnitFile?.state || 'unknown';
			service.broken = service.load === 'not-found';
			const memoryUsage = memoryMap.get(service.unit) || 0;
			const totalMemory = module.getState('memory')?.total;
			service.memory = {
				usage: memoryUsage,
				percent: totalMemory ? (memoryUsage / totalMemory) * 100 : 0
			};
			let state = `${service.active}:${service.sub}`;
			if (service.active === 'active' && service.sub === 'running') {
				state = 'running';
			} else if (service.active === 'active' && service.sub === 'exited') {
				state = 'oneshot';
			} else if (service.active === 'inactive' && service.sub === 'dead') {
				state = 'stopped';
			} else if (service.active === 'failed') {
				state = 'failed';
			}
			service.state = state;
			return service;
		});
		module.setState('services', services);
	} catch (error) {

	}
};

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
	await module.updateJobProgress(job, `${config.serviceName} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['enable', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} ${actionVerbs.pastTense}.`;
};

const enableStartService = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `${config.serviceName} is enabling and starting...`);
	await execa('systemctl', ['enable', '--now', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} enabled and started.`;
};

const disableService = async (job, module) => {
	const { config } = job.data;
	const actionVerbs = module.nlp.conjugate('disable');
	await module.updateJobProgress(job, `${config.serviceName} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['disable', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} ${actionVerbs.pastTense}.`;
};

const disableStopService = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `${config.serviceName} is disabling and stopping...`);
	await execa('systemctl', ['disable', '--now', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} disabled and stopped.`;
};

const startService = async (job, module) => {
	const { config } = job.data;
	const actionVerbs = module.nlp.conjugate('start');
	await module.updateJobProgress(job, `${config.serviceName} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['start', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} ${actionVerbs.pastTense}.`;
};

const stopService = async (job, module) => {
	const { config } = job.data;
	const actionVerbs = module.nlp.conjugate('stop');
	await module.updateJobProgress(job, `${config.serviceName} is ${actionVerbs.gerund}...`);
	await execa('systemctl', ['stop', config.serviceName]);
	module.eventEmitter.emit('host:system:services:updated');
	return `${config.serviceName} ${actionVerbs.pastTense}.`;
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
		'host:system:service:stop': stopService
	}
};
