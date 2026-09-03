const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, getLogiFormsLatestFile } = require('../controllers/settingsController');

router.get('/logiforms-latest-file', getLogiFormsLatestFile);
router.route('/').get(getSettings).put(updateSettings);

module.exports = router;
