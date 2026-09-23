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
    logiFormsFolderPath: {
      type: String,
      trim: true,
      default: '',
    },
    complianceReportEmailTemplate: {
      subject: {
        type: String,
        trim: true,
        default: '',
      },
      body: {
        type: String,
        trim: true,
        default: '',
      },
    },
    complianceReportEmailFromAddress: {
      type: String,
      trim: true,
      default: '',
    },
    applicantReminderEmailTemplate: {
      subject: {
        type: String,
        trim: true,
        default: '',
      },
      body: {
        type: String,
        trim: true,
        default: '',
      },
    },
    applicantReminderFromAddress: {
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
    logiFormsCheckIntervalMinutes: {
      type: Number,
      default: 60,
      min: 5,
      max: 1440,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
