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
    dropboxClientSubfolder: {
      type: String,
      trim: true,
      default: '',
    },
    shareFileClientSubfolder: {
      type: String,
      trim: true,
      default: '',
    },
    outlookRootPath: {
      type: String,
      trim: true,
      default: 'Clients',
    },
    outlookClientSubfolder: {
      type: String,
      trim: true,
      default: '',
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
