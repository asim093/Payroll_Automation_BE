const FileLog = require('../models/FileLog');

// @desc    Create a new file log
// @route   POST /api/file-logs
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

// @desc    Get all file logs
// @route   GET /api/file-logs
exports.getAllFileLogs = async (req, res, next) => {
  try {
    const fileLogs = await FileLog.find().populate('clientId');
    res.status(200).json(fileLogs);
  } catch (error) {
    next(error);
  }
};

// @desc    Get single file log by id
// @route   GET /api/file-logs/:id
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

// @desc    Update a file log
// @route   PUT /api/file-logs/:id
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

// @desc    Delete a file log
// @route   DELETE /api/file-logs/:id
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
