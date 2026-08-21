const mongoose = require('mongoose');

const processRunSchema = new mongoose.Schema(
  {
    lastRunAt: {
      type: Date,
      default: null,
    },
    lastRunResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    lastRunSuccess: {
      type: Boolean,
      default: null,
    },
    isRunning: {
      type: Boolean,
      default: false,
    },
    runStartedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const systemStatusSchema = new mongoose.Schema(
  {
    mailSync: {
      type: processRunSchema,
      default: () => ({}),
    },
    shareFileBridge: {
      type: processRunSchema,
      default: () => ({}),
    },
    lastEmailScanAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
