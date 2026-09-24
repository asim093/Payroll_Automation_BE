const express = require('express');
const router = express.Router();
const {
  getApplicantReminders,
  previewApplicantReminders,
  actionApplicantReminders,
  actionApplicantRemindersJob,
  getApplicantRemindersJobStatus,
  getActiveApplicantRemindersJob,
  dismissApplicantReminders,
  undismissApplicantReminders,
  deleteApplicantReminderDrafts,
} = require('../controllers/applicantReminderController');

router.get('/', getApplicantReminders);
router.post('/preview', previewApplicantReminders);
router.post('/action', actionApplicantReminders);
router.post('/action-job', actionApplicantRemindersJob);
router.get('/action-job/active', getActiveApplicantRemindersJob);
router.get('/action-job-status/:jobId', getApplicantRemindersJobStatus);
router.post('/dismiss', dismissApplicantReminders);
router.post('/undismiss', undismissApplicantReminders);
router.post('/delete-drafts', deleteApplicantReminderDrafts);

module.exports = router;
