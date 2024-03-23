const fs = require('fs');
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');

let docker = {
	templates: () => {
		return Promise.all([
			axios.get('https://raw.githubusercontent.com/univrs-cloud/virgo-apps/main/template.json'),
			si.dockerContainers(true)
		])
			.then(([responseTemplate, dockerContainers]) => {
				return responseTemplate.data.templates.map((template) => {
					let dockerContainer = dockerContainers.find((container) => {
						return container.name.includes(template.name);
					});
					template.isInstalled = (dockerContainer !== undefined);
					return template;
				});
			});
	},
	configured: () => {
		return Promise.all([
			fs.promises.readFile(path.join(__dirname,'../../data.json'), 'utf8'),
			si.dockerContainers(true)
		])
			.then(([responseData, dockerContainers]) => {
				let response = JSON.parse(responseData)
				response.containers = dockerContainers;
				return response;
			});
	},
	containers: () => {
		return si.dockerContainers(true);
	}
};

module.exports = docker;
