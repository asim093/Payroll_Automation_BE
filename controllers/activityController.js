const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');

exports.getActivityDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const separatorIndex = id.indexOf('-');
    if (separatorIndex === -1) {
      return res.status(400).json({ error: 'Invalid activity id - expected format "email-<id>" or "file-<id>"' });
    }

    const type = id.slice(0, separatorIndex);
    const recordId = id.slice(separatorIndex + 1);

    if (type === 'email') {
      const emailLog = await EmailLog.findById(recordId).populate('matchedClientId', 'name status');
      if (!emailLog) {
        return res.status(404).json({ error: 'Email log not found' });
      }

      const files = await FileLog.find({ sourceMessageId: emailLog.messageId })
        .populate('clientId', 'name')
        .sort({ createdAt: 1 });

      return res.status(200).json({ type: 'email', email: emailLog, files });
    }

    if (type === 'file') {
      const fileLog = await FileLog.findById(recordId).populate('clientId', 'name status');
      if (!fileLog) {
        return res.status(404).json({ error: 'File log not found' });
      }

      const email = fileLog.sourceMessageId
        ? await EmailLog.findOne({ messageId: fileLog.sourceMessageId }).select('subject sender receivedAt matchMethod')
        : null;

      return res.status(200).json({ type: 'file', file: fileLog, email });
    }

    return res.status(400).json({ error: `Unknown activity type "${type}"` });
  } catch (error) {
    next(error);
  }
};
