const express = require('express');
const router = express.Router();
const { triggerScan, getLastRunStatus } = require('../controllers/triggerController');

router.post('/trigger-scan', triggerScan);
router.get('/last-run-status', getLastRunStatus);

module.exports = router;
