const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    matchingRules: {
      emailAddresses: {
        type: [String],
        default: [],
      },
      domains: {
        type: [String],
        default: [],
      },
    
      notificationSenderPattern: {
        type: String,
        trim: true,
      },
    },
   
    outlookFolderPath: {
      type: String,
      trim: true,
    },
    
    outlookFolderId: {
      type: String,
      trim: true,
    },
   
    shareFilePath: {
      type: String,
      trim: true,
    },
    shareFilePathIsAbsolute: {
      type: Boolean,
      default: false,
    },
    dropboxPath: {
      type: String,
      trim: true,
    },
    dropboxPathIsAbsolute: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    folderSetupWarnings: {
      type: [String],
      default: [],
    },
    wotcFormUrl: {
      type: String,
      trim: true,
      default: '',
    },
    complianceReportFrequency: {
      type: String,
      enum: ['Monthly', 'Quarterly', 'Annually'],
    },
    emailSalutation: {
      type: String,
      trim: true,
    },
    complianceReportEmailDistribution: {
      type: String,
      trim: true,
    },
    fein: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

clientSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('Client', clientSchema);
