const {
  listCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
  dismissCustomerReportEmails,
  undismissCustomerReportEmails,
} = require('../services/customerReportEmailService');
const { createJob, getJob, recordResult } = require('../services/backgroundJobTracker');

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

// "Send All"/"Draft All" from the View Emails screen — same
// actionCustomerReportEmails work as the synchronous /action endpoint, just
// detached from the HTTP request via a background job (identical pattern to
// compliance report generation) so a large batch can't time out the request.
exports.actionCustomerReportEmailsJob = async (req, res, next) => {
  try {
    const ids = requireIds(req, res);
    if (!ids) return;
    const operatorEmail = req.headers['x-user-email'] || '';
    const mode = req.body?.mode === 'send' ? 'send' : 'draft';

    const jobId = createJob(ids);
    res.json({ success: true, jobId });

    actionCustomerReportEmails(ids, operatorEmail, mode, (result) => recordResult(jobId, result)).catch((error) => {
      console.error(`[CUSTOMER-REPORT-EMAILS] actionCustomerReportEmails job rejected unexpectedly: ${error.message}`);
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

exports.getCustomerReportEmailsJobStatus = (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have already expired).' });
  }
  res.json(job);
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
