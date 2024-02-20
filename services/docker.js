const si = require('systeminformation');
let docker = {
	containers: () => {
		return si.dockerContainers();
	}
};

module.exports = docker;
