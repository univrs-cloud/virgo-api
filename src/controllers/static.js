const path = require('path');
const express = require('express');

const folderPath = path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist');
const staticMiddleware = express.static(folderPath, {
	index: false,
	dotfiles: 'deny',
	etag: false
});

/**
 * Controller for serving static files and the root HTML.
 */
module.exports = {
	folderPath,
	staticMiddleware
};
