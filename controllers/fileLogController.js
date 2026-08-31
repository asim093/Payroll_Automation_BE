const FileLog = require('../models/FileLog');
const { retryFailedFile } = require('../services/fileRetryService');
const { formatError } = require('../utils/formatError');
const { getFileBuffer, getMimeType, getPreviewKind, parseTablePreview } = require('../services/filePreviewService');


exports.createFileLog = async (req, res, next) => {
  try {
    const { source, originalName } = req.body;

    if (!source || !['outlook', 'sharefile'].includes(source)) {
      return res.status(400).json({ error: 'source is required and must be "outlook" or "sharefile"' });
    }
    if (!originalName || !String(originalName).trim()) {
      return res.status(400).json({ error: 'originalName is required' });
    }

    const fileLog = await FileLog.create(req.body);
    res.status(201).json(fileLog);
  } catch (error) {
    next(error);
  }
};


exports.getAllFileLogs = async (req, res, next) => {
  try {
    const fileLogs = await FileLog.find().sort({ createdAt: -1 }).populate('clientId');
    res.status(200).json(fileLogs);
  } catch (error) {
    next(error);
  }
};


exports.getFileLogById = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findById(req.params.id).populate('clientId');
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    res.status(200).json(fileLog);
  } catch (error) {
    next(error);
  }
};


exports.updateFileLog = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    res.status(200).json(fileLog);
  } catch (error) {
    next(error);
  }
};


exports.retryFileLog = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findById(req.params.id);
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    if (fileLog.status !== 'failed') {
      return res.status(400).json({ error: 'Only failed files can be retried' });
    }

    await retryFailedFile(fileLog);

    const updated = await FileLog.findById(fileLog._id).populate('clientId');
    res.status(200).json(updated);
  } catch (error) {
    console.error(`retryFileLog ERROR: ${formatError(error)}`);
    res.status(502).json({ error: error.message });
  }
};


exports.getFileContent = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findById(req.params.id);
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    if (fileLog.status !== 'moved') {
      return res.status(409).json({ error: 'This file has not finished saving yet, so it cannot be opened.' });
    }

    const buffer = await getFileBuffer(fileLog);
    const mimeType = getMimeType(fileLog.originalName);
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    const safeName = String(fileLog.originalName || 'file').replace(/["\r\n]/g, '');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
    res.send(buffer);
  } catch (error) {
    console.error(`getFileContent ERROR (FileLog ${req.params.id}): ${formatError(error)}`);
    res.status(502).json({ error: error.message || 'Could not load this file right now.' });
  }
};


exports.getFilePreviewData = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findById(req.params.id);
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    if (fileLog.status !== 'moved') {
      return res.status(409).json({ error: 'This file has not finished saving yet, so it cannot be previewed.' });
    }
    if (getPreviewKind(fileLog.originalName) !== 'table') {
      return res.status(400).json({ error: 'This file type does not support a table preview.' });
    }

    const buffer = await getFileBuffer(fileLog);
    const table = await parseTablePreview(buffer, fileLog.originalName);
    res.status(200).json(table);
  } catch (error) {
    console.error(`getFilePreviewData ERROR (FileLog ${req.params.id}): ${formatError(error)}`);
    res.status(502).json({ error: error.message || 'Could not load a preview for this file right now.' });
  }
};


exports.deleteFileLog = async (req, res, next) => {
  try {
    const fileLog = await FileLog.findByIdAndDelete(req.params.id);
    if (!fileLog) {
      return res.status(404).json({ error: 'File log not found' });
    }
    res.status(200).json({ message: 'File log deleted successfully' });
  } catch (error) {
    next(error);
  }
};
