const EmailLog = require('../models/EmailLog');


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


exports.getAllEmailLogs = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { archived: { $ne: true } };
    const emailLogs = await EmailLog.find(filter).sort({ createdAt: -1 }).populate('matchedClientId');
    res.status(200).json(emailLogs);
  } catch (error) {
    next(error);
  }
};


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
