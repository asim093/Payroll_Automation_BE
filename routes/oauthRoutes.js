const express = require('express');
const router = express.Router();
const { startMicrosoftLogin, microsoftLoginCallback } = require('../controllers/oauthController');
const { startShareFileLogin, shareFileLoginCallback } = require('../controllers/shareFileOAuthController');

router.get('/microsoft/start', startMicrosoftLogin);
router.get('/microsoft/callback', microsoftLoginCallback);

router.get('/sharefile/start', startShareFileLogin);
router.get('/sharefile/callback', shareFileLoginCallback);

module.exports = router;
