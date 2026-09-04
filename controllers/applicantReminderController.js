const {
  listReminders,
  previewReminders,
  actionReminders,
} = require('../services/applicantReminderService');

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
    const { clientId, status } = req.query;
    const reminders = await listReminders({ clientId, status });
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
    const results = await actionReminders(ids, operatorEmail);
    res.status(200).json(results);
  } catch (error) {
    next(error);
  }
};
