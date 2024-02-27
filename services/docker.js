const fs = require('fs');
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');

let docker = {
	templates: () => {
		return axios.get('https://raw.githubusercontent.com/univrs-cloud/portainer/main/template.json')
			.then((response) => {
				return response.data.templates;
			});
	},
	configured: () => {
		return fs.promises.readFile(path.join(__dirname,'../../data.json'), 'utf8')
			.then((data) => {
				return JSON.parse(data);
			});
	},
	containers: () => {
		return si.dockerContainers();
	}
};

module.exports = docker;
