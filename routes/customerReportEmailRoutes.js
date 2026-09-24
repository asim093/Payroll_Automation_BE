const express = require('express');
const router = express.Router();
const {
  getCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
  actionCustomerReportEmailsJob,
  getCustomerReportEmailsJobStatus,
  getActiveCustomerReportEmailsJob,
  dismissCustomerReportEmails,
  undismissCustomerReportEmails,
  deleteCustomerReportEmailDrafts,
} = require('../controllers/customerReportEmailController');

router.get('/', getCustomerReportEmails);
router.post('/preview', previewCustomerReportEmails);
router.post('/action', actionCustomerReportEmails);
router.post('/action-job', actionCustomerReportEmailsJob);
router.get('/action-job/active', getActiveCustomerReportEmailsJob);
router.get('/action-job-status/:jobId', getCustomerReportEmailsJobStatus);
router.post('/dismiss', dismissCustomerReportEmails);
router.post('/undismiss', undismissCustomerReportEmails);
router.post('/delete-drafts', deleteCustomerReportEmailDrafts);

module.exports = router;
