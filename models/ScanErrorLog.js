const mongoose = require('mongoose');

const scanErrorLogSchema = new mongoose.Schema(
  {
    processKey: {
      type: String,
      required: true,
      index: true,
    },
    scope: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    occurredAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScanErrorLog', scanErrorLogSchema);
