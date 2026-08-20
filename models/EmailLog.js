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
    // PHASE 11 — true when a copy of this email was successfully filed
    // into the matched client's dedicated Outlook mail folder (see
    // emailProcessor.js's completeFileProcessing() / graphService.js's
    // copyEmailToFolder()). False for needs_review emails (no client yet),
    // for emails with no successfully-saved attachments (nothing to
    // "back up" this way), or if the client has no outlookFolderId on
    // file / the copy call itself failed - never blocks the rest of
    // processing either way.
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
    // Set only by scripts/seedDemoActivity.js — lets the dashboard flag
    // seeded rows (see components/RecentActivityTable.jsx) and lets
    // scripts/removeDemoActivity.js find exactly (and only) what it
    // inserted, without touching real data.
    isDemoData: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailLog', emailLogSchema);
