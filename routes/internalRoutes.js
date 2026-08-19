const express = require('express');
const router = express.Router();
const { notifyProgress } = require('../controllers/internalController');

router.post('/notify-progress', notifyProgress);

module.exports = router;
