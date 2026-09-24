const {
  listReminders,
  previewReminders,
  actionReminders,
  dismissReminders,
  undismissReminders,
  deleteReminderDrafts,
} = require('../services/applicantReminderService');
const { createEmailActionJob, getEmailActionJob, getActiveEmailActionJob } = require('../services/emailActionJobService');

const requireIds = (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids must be a non-empty array' });
    return null;
  }
  return ids;
};

exports.getApplicantReminders = async (req, res, next) => {
  try {
    const { clientId, status, sortBy, sortDir, complianceReportLogId, search, page, limit } = req.query;
    const reminders = await listReminders({ clientId, status, sortBy, sortDir, complianceReportLogId, search, page, limit });
    res.status(200).json(reminders);
  } catch (error) {
    next(error);
  }
};

exports.previewApplicantReminders = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await previewReminders(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

exports.actionApplicantReminders = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';
    const results = await actionReminders(ids, operatorEmail, mode);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

// "Send All"/"Draft All" from the View Emails screen — DB-backed job
// (EmailActionJob) instead of the old in-memory tracker: survives a server
// restart, tracks per-item status live, and is resumable. The mode==='send'
// safety gate lives inside createEmailActionJob and runs BEFORE the job
// document is created, so attempting Send All today (Mail.Send not yet
// granted) fails with a clean 400 and creates nothing at all.
exports.actionApplicantRemindersJob = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';

    const jobId = await createEmailActionJob({ sourceType: 'applicant_reminder', mode, itemIds: ids, operatorEmail });
    res.json({ success: true, jobId });
  } catch (error) {
    next(error);
  }
};

exports.getApplicantRemindersJobStatus = async (req, res, next) => {
  try {
    const job = await getEmailActionJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found (it may have already expired).' });
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
};

exports.getActiveApplicantRemindersJob = async (req, res, next) => {
  try {
    const job = await getActiveEmailActionJob('applicant_reminder');
    res.json({ active: Boolean(job), job });
  } catch (error) {
    next(error);
  }
};

exports.dismissApplicantReminders = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const results = await dismissReminders(ids, operatorEmail);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

exports.undismissApplicantReminders = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await undismissReminders(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

// Bulk-delete for the Drafts view: removes the real Graph draft AND the
// local row for each id — only rows actually in 'draft_created' are
// touched (deleteReminderDrafts re-checks this per item regardless of what
// the UI already filtered).
exports.deleteApplicantReminderDrafts = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await deleteReminderDrafts(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};
