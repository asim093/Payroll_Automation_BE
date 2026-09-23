const express = require('express');
const router = express.Router();
const { notifyProgress, notifyClientDataChanged } = require('../controllers/internalController');

router.post('/notify-progress', notifyProgress);
router.post('/notify-client-data-changed', notifyClientDataChanged);

module.exports = router;
