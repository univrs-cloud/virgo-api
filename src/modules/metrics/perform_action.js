const { execa } = require('execa');

const enable = async (job, module) => {
	try {
		await execa('zfs', ['list', 'messier/metrics', '-j']);
	  } catch {
		await execa('mkdir', ['-p', '/var/log/pcp/pmlogger']);
		await execa('zfs', ['create', 'messier/metrics', '-o', 'mountpoint=/var/log/pcp/pmlogger', '-o', 'recordsize=128K', '-o', 'quota=5G']);
	}
	try {
		await execa('dpkg', ['-s', 'pcp-zeroconf']);
	} catch (error) {
		await module.updateJobProgress(job, `Installing metrics packages...`);
		await execa('apt', ['install', 'pcp-zeroconf', '-y']);
		await module.updateJobProgress(job, `Metrics packages installed.`);
	}
	await module.updateJobProgress(job, `Enabling metrics...`);
	await execa('systemctl', ['enable', '--now', 'pmcd.service', 'pmlogger.service', 'pmlogger_farm.service', 'pmproxy.service']);
	await execa('systemctl', ['enable', '--now', 'pmlogger_check.timer', 'pmlogger_daily.timer', 'pmlogger_farm_check.timer']);
	module.eventEmitter.emit('metrics:enabled');
	module.eventEmitter.emit('host:system:services:updated');
	return `Metrics enabled.`;
};

const disable = async (job, module) => {
	await module.updateJobProgress(job, `Disabling metrics...`);
	await execa('systemctl', ['disable', '--now', 'pmlogger_check.timer', 'pmlogger_daily.timer', 'pmlogger_farm_check.timer']);
	await execa('systemctl', ['disable', '--now', 'pmcd.service', 'pmlogger.service', 'pmlogger_farm.service', 'pmproxy.service']);
	module.eventEmitter.emit('metrics:disabled');
	module.eventEmitter.emit('host:system:services:updated');
	return `Metrics disabled.`;
};

const onConnection = (socket, module) => {
	socket.on('metrics:enable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('metrics:enable', { username: socket.username });
	});
	socket.on('metrics:disable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('metrics:disable', { username: socket.username });
	});
};

module.exports = {
	name: 'perform_action',
	onConnection,
	jobs: {
		'metrics:enable': enable,
		'metrics:disable': disable
	}
};
