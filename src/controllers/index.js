import path from 'path';
import express from 'express';
import * as staticController from './static.js';
import session from './session.js';

const router = express.Router();

// Ahead of the static handlers: everything below ends at a catch-all that answers with the app shell.
router.use(session);
router.use('/assets/img/apps', express.static(staticController.appsIconsDir, staticController.configIconsOptions));
router.use('/assets/img/bookmarks', express.static(staticController.bookmarksIconsDir, staticController.configIconsOptions));
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

export default router;
