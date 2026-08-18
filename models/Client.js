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
    // Client-specific value substituted for the "{Client Name}" placeholder
    // in Settings' shareFilePathTemplate (see utils/pathTemplate.js).
    // Editable per-client via AddClientModal's Destination Preview, defaults
    // to the client's name if left blank. Empty/missing on clients created
    // before this field existed - sharefileService.js falls back to
    // client.name in that case.
    shareFilePath: {
      type: String,
      trim: true,
    },
    // Client-specific value substituted for the "{Client Name}" placeholder
    // in Settings' dropboxPathTemplate (see utils/pathTemplate.js).
    // Editable per-client via AddClientModal's Destination Preview, defaults
    // to the client's name if left blank. Empty/missing on clients created
    // before this field existed - dropboxService.js falls back to
    // client.name in that case.
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
