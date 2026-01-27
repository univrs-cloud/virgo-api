const path = require('path');
const express = require('express');
const router = express.Router();
const staticController = require('./static');

router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

module.exports = router;
