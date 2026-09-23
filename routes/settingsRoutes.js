const express = require('express');
const router = express.Router();
const {
  getSettings,
  updateSettings,
  getLogiFormsLatestFile,
  checkLogiFormsIngestNow,
  getLogiFormsIngestStatus,
} = require('../controllers/settingsController');

router.get('/logiforms-latest-file', getLogiFormsLatestFile);
router.post('/logiforms-check-now', checkLogiFormsIngestNow);
router.get('/logiforms-ingest-status', getLogiFormsIngestStatus);
router.route('/').get(getSettings).put(updateSettings);

module.exports = router;
