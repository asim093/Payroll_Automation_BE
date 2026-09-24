const {
  listCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
  dismissCustomerReportEmails,
  undismissCustomerReportEmails,
  deleteCustomerReportEmailDrafts,
} = require('../services/customerReportEmailService');
const { createEmailActionJob, getEmailActionJob, getActiveEmailActionJob } = require('../services/emailActionJobService');

const requireIds = (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids must be a non-empty array' });
    return null;
  }
  return ids;
};

exports.getCustomerReportEmails = async (req, res, next) => {
  try {
    const { clientId, status, search, sortBy, sortDir, page, limit, complianceReportLogId } = req.query;
    const result = await listCustomerReportEmails({
      clientId,
      status,
      search,
      sortBy,
      sortDir,
      page,
      limit,
      complianceReportLogId,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.previewCustomerReportEmails = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await previewCustomerReportEmails(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

exports.actionCustomerReportEmails = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';
    const results = await actionCustomerReportEmails(ids, operatorEmail, mode);
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
exports.actionCustomerReportEmailsJob = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';

    const jobId = await createEmailActionJob({ sourceType: 'customer_report_email', mode, itemIds: ids, operatorEmail });
    res.json({ success: true, jobId });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerReportEmailsJobStatus = async (req, res, next) => {
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

exports.getActiveCustomerReportEmailsJob = async (req, res, next) => {
  try {
    const job = await getActiveEmailActionJob('customer_report_email');
    res.json({ active: Boolean(job), job });
  } catch (error) {
    next(error);
  }
};

exports.dismissCustomerReportEmails = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const results = await dismissCustomerReportEmails(ids, operatorEmail);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

exports.undismissCustomerReportEmails = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await undismissCustomerReportEmails(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};

// Bulk-delete for the Drafts view: removes the real Graph draft AND the
// local row for each id — only rows actually in 'draft_created' are
// touched (deleteCustomerReportEmailDrafts re-checks this per item
// regardless of what the UI already filtered).
exports.deleteCustomerReportEmailDrafts = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const results = await deleteCustomerReportEmailDrafts(ids);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};
