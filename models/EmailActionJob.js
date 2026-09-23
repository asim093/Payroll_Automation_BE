const mongoose = require('mongoose');

// Per-item lifecycle: pending -> processing -> a terminal status. Every item
// is pre-created as 'pending' at job-creation time (unlike
// ComplianceGenerationJob's results array, which only grows as each client
// finishes) so a progress view can render a full "X of N" list immediately.
const emailActionJobItemSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: {
      type: String,
      enum: [
        'pending',
        'processing',
        'draft_created',
        'sent',
        'failed',
        'skipped_no_email',
        'skipped_no_form_url',
        'already_sent',
        'already_draft_created',
        'dismissed',
        'superseded',
        'not_found',
        'client_not_found',
      ],
      default: 'pending',
    },
    graphMessageId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const emailActionJobSchema = new mongoose.Schema(
  {
    // Which collection itemIds point into — ApplicantReminder rows or
    // CustomerReportEmail rows. Each source type's own service function
    // (actionReminders / actionCustomerReportEmails) is reused per item
    // rather than duplicating draft/send logic here.
    sourceType: {
      type: String,
      enum: ['applicant_reminder', 'customer_report_email'],
      required: true,
    },
    mode: {
      type: String,
      enum: ['draft', 'send'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'completed_with_errors', 'failed'],
      default: 'pending',
      required: true,
    },
    operatorEmail: { type: String, default: '' },
    total: { type: Number, required: true },
    items: { type: [emailActionJobItemSchema], default: [] },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

emailActionJobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
emailActionJobSchema.index({ sourceType: 1, status: 1, startedAt: -1 });

module.exports = mongoose.model('EmailActionJob', emailActionJobSchema);
