const express = require('express');
const router = express.Router();
const {
  getApplicantReminders,
  previewApplicantReminders,
  actionApplicantReminders,
} = require('../controllers/applicantReminderController');

router.get('/', getApplicantReminders);
router.post('/preview', previewApplicantReminders);
router.post('/action', actionApplicantReminders);

module.exports = router;
