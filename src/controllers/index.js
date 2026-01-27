const path = require('path');
const express = require('express');
const router = express.Router();
const staticController = require('./static');
const authController = require('./auth');

// API routes (before static middleware)
router.use('/api/auth', authController);
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

module.exports = router;
