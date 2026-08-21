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
    dropboxPath: {
      type: String,
      trim: true,
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
  },
  { timestamps: true }
);

clientSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('Client', clientSchema);
