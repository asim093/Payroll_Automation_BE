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
    sourceFileId: {
      type: String,
      trim: true,
      index: true,
    },
    sourceMessageId: {
      type: String,
      trim: true,
      index: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      index: true,
    },
    destinationPath: {
      type: String,
      trim: true,
    },
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
    fallbackUsed: {
      type: Boolean,
      default: false,
    },
    errorMessage: {
      type: String,
      trim: true,
    },
    matchMethod: {
      type: String,
      enum: ['exact_email', 'domain', 'notification_pattern', 'manual', 'folder_scan'],
    },
    isDemoData: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FileLog', fileLogSchema);
