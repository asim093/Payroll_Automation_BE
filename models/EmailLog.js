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
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    sourceType: {
      type: String,
      enum: ['outlook_attachment', 'sharefile_notification'],
      default: 'outlook_attachment',
    },
    // Which Graph auth flow fetched this email — needed later if a
    // needs_review item gets manually resolved, so we know whether to use
    // the delegated (Authorization Code) or app-only (client credentials)
    // token/mailbox to re-fetch it from Outlook.
    authMode: {
      type: String,
      enum: ['delegated', 'app-only'],
      default: 'app-only',
    },
    // Set when a manual review-queue resolve's file-processing step fails
    // (e.g. attachment no longer available, token expired) — shown on the
    // dashboard so it's clear why status is 'failed'.
    processingError: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailLog', emailLogSchema);
