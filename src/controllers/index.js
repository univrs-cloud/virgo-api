const express = require('express');
const router = express.Router();
const staticController = require('./static');

router.use('/', staticController.serveStaticFiles);

module.exports = router;
