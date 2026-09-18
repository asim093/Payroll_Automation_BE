const ColumnMapping = require('../models/ColumnMapping');

exports.getAllColumnMappings = async (req, res, next) => {
  try {
    const mappings = await ColumnMapping.find().lean();
    res.status(200).json(mappings);
  } catch (error) {
    next(error);
  }
};

// Only alternativeNames is editable here — destinationField is fixed to its
// 4-value enum for the life of the document (no create/delete on this model).
exports.updateAlternativeNames = async (req, res, next) => {
  try {
    if (!Array.isArray(req.body.alternativeNames)) {
      return res.status(400).json({ error: 'alternativeNames must be an array of strings' });
    }

    const doc = await ColumnMapping.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Column mapping not found' });
    }

    const cleaned = req.body.alternativeNames.map((name) => String(name || '').trim()).filter(Boolean);

    const seen = new Set();
    for (const name of cleaned) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        return res.status(400).json({ error: `"${name}" is listed more than once.` });
      }
      seen.add(key);
    }

    const others = await ColumnMapping.find({ _id: { $ne: doc._id } }).lean();
    for (const name of cleaned) {
      const key = name.toLowerCase();
      const conflict = others.find((other) => (other.alternativeNames || []).some((n) => n.toLowerCase() === key));
      if (conflict) {
        return res.status(409).json({
          error: `"${name}" is already mapped to "${conflict.destinationField}" — a header name can only map to one field.`,
        });
      }
    }

    doc.alternativeNames = cleaned;
    await doc.save();
    res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};
