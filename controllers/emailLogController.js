const EmailLog = require('../models/EmailLog');

// @desc    Create a new email log
// @route   POST /api/email-logs
exports.createEmailLog = async (req, res, next) => {
  try {
    const { messageId, sender } = req.body;

    if (!messageId || !String(messageId).trim()) {
      return res.status(400).json({ error: 'messageId is required' });
    }
    if (!sender || !String(sender).trim()) {
      return res.status(400).json({ error: 'sender is required' });
    }

    const emailLog = await EmailLog.create(req.body);
    res.status(201).json(emailLog);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all email logs
// @route   GET /api/email-logs
exports.getAllEmailLogs = async (req, res, next) => {
  try {
    const emailLogs = await EmailLog.find().populate('matchedClientId');
    res.status(200).json(emailLogs);
  } catch (error) {
    next(error);
  }
};

// @desc    Get single email log by id
// @route   GET /api/email-logs/:id
exports.getEmailLogById = async (req, res, next) => {
  try {
    const emailLog = await EmailLog.findById(req.params.id).populate('matchedClientId');
    if (!emailLog) {
      return res.status(404).json({ error: 'Email log not found' });
    }
    res.status(200).json(emailLog);
  } catch (error) {
    next(error);
  }
};

// @desc    Update an email log
// @route   PUT /api/email-logs/:id
exports.updateEmailLog = async (req, res, next) => {
  try {
    const emailLog = await EmailLog.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!emailLog) {
      return res.status(404).json({ error: 'Email log not found' });
    }
    res.status(200).json(emailLog);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete an email log
// @route   DELETE /api/email-logs/:id
exports.deleteEmailLog = async (req, res, next) => {
  try {
    const emailLog = await EmailLog.findByIdAndDelete(req.params.id);
    if (!emailLog) {
      return res.status(404).json({ error: 'Email log not found' });
    }
    res.status(200).json({ message: 'Email log deleted successfully' });
  } catch (error) {
    next(error);
  }
};
