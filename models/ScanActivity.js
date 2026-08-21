const mongoose = require('mongoose');

const scanActivitySchema = new mongoose.Schema(
  {
    processKey: {
      type: String,
      enum: ['mailSync', 'shareFileBridge'],
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    phaseLabel: {
      type: String,
      trim: true,
      default: null,
    },
    totalItems: {
      type: Number,
      default: 0,
    },
    processedItems: {
      type: Number,
      default: 0,
    },
    currentItemLabel: {
      type: String,
      trim: true,
      default: null,
    },
    currentItemStartedAt: {
      type: Date,
      default: null,
    },
    phaseStartedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScanActivity', scanActivitySchema);
