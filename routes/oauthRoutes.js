const express = require('express');
const router = express.Router();
const { startMicrosoftLogin, microsoftLoginCallback } = require('../controllers/oauthController');
const { startShareFileLogin, shareFileLoginCallback } = require('../controllers/shareFileOAuthController');
const { startDropboxLogin, dropboxLoginCallback } = require('../controllers/dropboxOAuthController');
const { runOAuthSmokeTest } = require('../controllers/oauthSmokeTestController');

router.get('/microsoft/start', startMicrosoftLogin);
router.get('/microsoft/callback', microsoftLoginCallback);

router.get('/sharefile/start', startShareFileLogin);
router.get('/sharefile/callback', shareFileLoginCallback);

router.get('/dropbox/start', startDropboxLogin);
router.get('/dropbox/callback', dropboxLoginCallback);

router.get('/smoke-test', runOAuthSmokeTest);

module.exports = router;
