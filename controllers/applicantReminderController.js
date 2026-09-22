const {
  listReminders,
  previewReminders,
  actionReminders,
  dismissReminders,
  undismissReminders,
} = require('../services/applicantReminderService');
const { createJob, getJob, recordResult } = require('../services/backgroundJobTracker');

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
    const { clientId, status, sortBy, sortDir, complianceReportLogId } = req.query;
    const reminders = await listReminders({ clientId, status, sortBy, sortDir, complianceReportLogId });
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

// "Send All"/"Draft All" from the View Emails screen — same actionReminders
// work as the synchronous /action endpoint, just detached from the HTTP
// request via a background job (identical pattern to compliance report
// generation) so a large batch can't time out the request.
exports.actionApplicantRemindersJob = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';

    const jobId = createJob(ids);
    res.json({ success: true, jobId });

    actionReminders(ids, operatorEmail, mode, (result) => recordResult(jobId, result)).catch((error) => {
      console.error(`[APPLICANT-REMINDERS] actionReminders job rejected unexpectedly: ${error.message}`);
      const job = getJob(jobId);
      const alreadyReported = job ? job.completed : 0;
      for (let i = alreadyReported; i < ids.length; i += 1) {
        recordResult(jobId, { id: ids[i], status: 'failed', error: error.message });
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getApplicantRemindersJobStatus = (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have already expired).' });
  }
  res.json(job);
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
