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
			for (const line of stdout.split('\n')) {
				if (line.startsWith('Id=')) {
					currentId = line.slice(3);
				} else if (line.startsWith('MemoryCurrent=') && currentId) {
					const value = line.slice(14);
					memoryMap.set(currentId, /^\d+$/.test(value) ? parseInt(value, 10) : null);
					currentId = null;
				}
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

const register = (module) => {
	loadServices(module);

	module.eventEmitter
			.on('host:system:services:updated', async () => {
				await loadServices(module);
				for (const socket of module.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('host:system:services', module.getState('services'));
					}
				}
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

		await loadServices(module);
		for (const socket of module.nsp.sockets.values()) {
			if (socket.isAuthenticated && socket.isAdmin) {
				socket.emit('host:system:services', module.getState('services'));
			}
		}
	});
};

module.exports = {
	name: 'services',
	register,
	onConnection
};
