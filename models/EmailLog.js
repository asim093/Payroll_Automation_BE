const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const emailLogSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    sender: {
      type: String,
      required: true,
      trim: true,
    },
    subject: {
      type: String,
      trim: true,
    },
    receivedAt: {
      type: Date,
    },
    matchedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      index: true,
    },
    status: {
      type: String,
      enum: ['processed', 'needs_review', 'failed'],
      default: 'needs_review',
    },
    categoryAssigned: {
      type: Boolean,
      default: false,
    },
    outlookCopySaved: {
      type: Boolean,
      default: false,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    sourceType: {
      type: String,
      enum: ['outlook_attachment', 'sharefile_notification'],
      default: 'outlook_attachment',
    },
    authMode: {
      type: String,
      enum: ['delegated', 'app-only'],
      default: 'app-only',
    },

    processingError: {
      type: String,
      trim: true,
    },
    isDemoData: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailLog', emailLogSchema);
