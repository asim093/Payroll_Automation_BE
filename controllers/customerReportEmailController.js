const {
  listCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
} = require('../services/customerReportEmailService');

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
    const { clientId, status, search, sortBy, sortDir, page, limit } = req.query;
    const result = await listCustomerReportEmails({ clientId, status, search, sortBy, sortDir, page, limit });
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
