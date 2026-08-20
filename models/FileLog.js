const mongoose = require('mongoose');

const fileLogSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ['outlook', 'sharefile'],
      required: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    // ShareFile's own file Id (from the scheduled scan — see
    // scanShareFileForNewFiles()). Used to detect "have we already
    // processed this exact ShareFile item" without depending on filenames,
    // which can repeat. Not unique-indexed: a Dropbox+local fallback pair
    // for the same source file legitimately shares one sourceFileId.
    sourceFileId: {
      type: String,
      trim: true,
      index: true,
    },
    // Graph messageId of the source email, set when source === 'outlook'.
    // The attachment's actual bytes are never persisted anywhere once a
    // save fails (see emailProcessor.js's saveToDestinations()) - this is
    // what lets a failed file be RETRIED later: services/
    // fileRetryService.js uses it to re-fetch the same attachment from
    // Outlook by name. Unset on FileLogs created before this field existed.
    sourceMessageId: {
      type: String,
      trim: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
    destinationPath: {
      type: String,
      trim: true,
    },
    // Where this particular copy of the file landed — one FileLog entry is
    // created per destination, so a single attachment saved both locally
    // and to Dropbox produces two entries (one each).
    destination: {
      type: String,
      enum: ['local', 'dropbox'],
      default: 'local',
    },
    processedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['moved', 'needs_review', 'failed'],
      default: 'needs_review',
    },
    // True when this entry landed on local disk specifically because the
    // Dropbox upload attempt (tried first) failed — not just "no token set".
    fallbackUsed: {
      type: Boolean,
      default: false,
    },
    // Set when both Dropbox and local storage failed for this file, so the
    // dashboard can show why status is 'failed'.
    errorMessage: {
      type: String,
      trim: true,
    },
    // Set only by scripts/seedDemoActivity.js — see EmailLog.js's matching
    // field for why.
    isDemoData: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FileLog', fileLogSchema);
