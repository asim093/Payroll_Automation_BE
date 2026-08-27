const express = require('express');
const router = express.Router();
const { generateReports, getComplianceReportStatus } = require('../controllers/complianceReportController');

router.post('/generate', generateReports);
router.get('/status', getComplianceReportStatus);

module.exports = router;
