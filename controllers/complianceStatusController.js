const ComplianceStatus = require('../models/ComplianceStatus');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getAllComplianceStatuses = async (req, res, next) => {
  try {
    const statuses = await ComplianceStatus.find().sort({ statusValue: 1 }).lean();
    res.status(200).json(statuses);
  } catch (error) {
    next(error);
  }
};

exports.createComplianceStatus = async (req, res, next) => {
  try {
    const statusValue = String(req.body.statusValue || '').trim();
    if (!statusValue) {
      return res.status(400).json({ error: 'statusValue is required' });
    }
    const isComplete = req.body.isComplete !== undefined ? Boolean(req.body.isComplete) : true;

    const existing = await ComplianceStatus.findOne({
      statusValue: { $regex: `^${escapeRegex(statusValue)}$`, $options: 'i' },
    });
    if (existing) {
      return res.status(409).json({ error: `"${statusValue}" already exists.` });
    }

    const created = await ComplianceStatus.create({ statusValue, isComplete });
    res.status(201).json(created);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'This status value already exists.' });
    }
    next(error);
  }
};

// statusValue is immutable once created — only isComplete can change.
exports.updateComplianceStatus = async (req, res, next) => {
  try {
    if (req.body.isComplete === undefined) {
      return res.status(400).json({ error: 'isComplete is required' });
    }
    const doc = await ComplianceStatus.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Compliance status not found' });
    }
    doc.isComplete = Boolean(req.body.isComplete);
    await doc.save();
    res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

exports.deleteComplianceStatus = async (req, res, next) => {
  try {
    const doc = await ComplianceStatus.findByIdAndDelete(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Compliance status not found' });
    }
    res.status(200).json({ message: 'Deleted' });
  } catch (error) {
    next(error);
  }
};
