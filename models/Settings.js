const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    dropboxRootPath: {
      type: String,
      trim: true,
      default: 'WOTC',
    },
    shareFileRootPath: {
      type: String,
      trim: true,
      default: 'Clients',
    },
    outlookRootPath: {
      type: String,
      trim: true,
      default: 'Clients',
    },

    mailSyncIntervalMinutes: {
      type: Number,
      default: 5,
      min: 5,
      max: 180,
    },
    shareFileBridgeIntervalMinutes: {
      type: Number,
      default: 5,
      min: 5,
      max: 180,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
