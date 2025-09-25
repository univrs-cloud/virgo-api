const path = require('path');
const express = require('express');

const staticPath = path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist');
const staticMiddleware = express.static(staticPath, {
	index: ['index.html'],
	dotfiles: 'deny',
	etag: false
});

/**
 * Controller for serving static files and the root HTML.
 */
module.exports = {
	serveStaticFiles: staticMiddleware
};
