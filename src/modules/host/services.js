const { execa } = require('execa');

const fetchServices = async (socket, module) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}
	
	try {
		const [{ stdout: serviceUnitsList }, { stdout: serviceUnitFilesList }] = await Promise.all([
			execa('systemctl', ['list-units', '--type=service', '--all', '--output=json']),
			execa('systemctl', ['list-unit-files', '--type=service', '--output=json'])
		]);
		const serviceUnits = JSON.parse(serviceUnitsList);
		const serviceUnitFiles = JSON.parse(serviceUnitFilesList);
		const services = serviceUnits.map((service) => {
			const serviceUnitFile = serviceUnitFiles.find((serviceUnitFile) => { return serviceUnitFile.unit_file === service.unit; });
			service.unitFileState = serviceUnitFile?.state || 'unknown';
			service.broken = service.load === 'not-found';
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
		socket.emit('host:system:services', module.getState('services'));
	} catch (error) {

	}
};

const onConnection = (socket, module) => {
	if (this.getState('services')) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('host:system:services', module.getState('services'));
		}
	}

	socket.on('host:system:services:fetch', () => { 
		fetchServices(socket, module);
	});
};

module.exports = {
	name: 'services',
	onConnection
};
