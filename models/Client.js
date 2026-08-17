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
      // Sender-domain (or address) pattern used to recognize this client's
      // ShareFile "new item" notification emails, e.g. "logiforms.com".
      notificationSenderPattern: {
        type: String,
        trim: true,
      },
    },
    // Not read by the processing pipeline currently — emails stay in their
    // original Outlook location (Inbox) per requirements, only file-copies
    // move to destination. Kept (optional, no validation depends on it) for
    // future-proofing and so existing data isn't lost.
    outlookFolderPath: {
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
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Client', clientSchema);
