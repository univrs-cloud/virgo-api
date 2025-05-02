const path = require('path');
const express = require('express');

/**
 * Controller for serving static files and the root HTML.
 */
module.exports = {
  serveStaticFiles: (req, res, next) => {
    express.static(path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist'), { index: ['index.html'] })(req, res, next);
  }
};
