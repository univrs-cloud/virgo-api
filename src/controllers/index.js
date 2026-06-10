import path from 'path';
import express from 'express';
import staticController from './static.js';

const router = express.Router();

router.use('/assets/img/apps', express.static(staticController.appsIconsDir, staticController.configIconsOptions));
router.use('/assets/img/bookmarks', express.static(staticController.bookmarksIconsDir, staticController.configIconsOptions));
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

export default router;
