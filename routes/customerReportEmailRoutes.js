const express = require('express');
const router = express.Router();
const {
  getCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
} = require('../controllers/customerReportEmailController');

router.get('/', getCustomerReportEmails);
router.post('/preview', previewCustomerReportEmails);
router.post('/action', actionCustomerReportEmails);

module.exports = router;
