const express = require('express');
const router = express.Router();
const {
  generateReports,
  getGenerateReportsStatus,
  getActiveGenerateStatus,
  getComplianceReportStatus,
  downloadComplianceReport,
  getComplianceReportHistory,
  downloadComplianceReportById,
  getComplianceReportLogEmployees,
} = require('../controllers/complianceReportController');

router.post('/generate', generateReports);
router.get('/generate-status/active', getActiveGenerateStatus);
router.get('/generate-status/:jobId', getGenerateReportsStatus);
router.get('/status', getComplianceReportStatus);
router.get('/history', getComplianceReportHistory);
router.get('/logs/:logId/download', downloadComplianceReportById);
router.get('/logs/:logId/employees', getComplianceReportLogEmployees);
router.get('/:clientId/download', downloadComplianceReport);

module.exports = router;
