const path = require('path');
const express = require('express');
const router = express.Router();
const staticController = require('./static');

router.use('/assets/img/apps', express.static(staticController.appsIconsDir, staticController.configIconsOptions));
router.use('/assets/img/bookmarks', express.static(staticController.bookmarksIconsDir, staticController.configIconsOptions));
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

module.exports = router;
