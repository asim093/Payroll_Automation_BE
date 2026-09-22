const express = require('express');
const router = express.Router();
const {
  getApplicantReminders,
  previewApplicantReminders,
  actionApplicantReminders,
  actionApplicantRemindersJob,
  getApplicantRemindersJobStatus,
  dismissApplicantReminders,
  undismissApplicantReminders,
} = require('../controllers/applicantReminderController');

router.get('/', getApplicantReminders);
router.post('/preview', previewApplicantReminders);
router.post('/action', actionApplicantReminders);
router.post('/action-job', actionApplicantRemindersJob);
router.get('/action-job-status/:jobId', getApplicantRemindersJobStatus);
router.post('/dismiss', dismissApplicantReminders);
router.post('/undismiss', undismissApplicantReminders);

module.exports = router;
