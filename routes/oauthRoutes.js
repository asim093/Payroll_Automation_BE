const express = require('express');
const router = express.Router();
const { startMicrosoftLogin, microsoftLoginCallback } = require('../controllers/oauthController');

router.get('/microsoft/start', startMicrosoftLogin);
router.get('/microsoft/callback', microsoftLoginCallback);

module.exports = router;
