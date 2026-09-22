const mongoose = require('mongoose');

const REPORT_EMAIL_STATUSES = ['pending', 'draft_created', 'sent', 'skipped_no_email', 'failed', 'superseded', 'dismissed'];

const customerReportEmailSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    complianceReportLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ComplianceReportLog',
      required: true,
    },
    generatedAt: {
      type: Date,
    },
    emailSalutation: {
      type: String,
      trim: true,
      default: '',
    },
    customerEmail: {
      type: String,
      trim: true,
      default: '',
    },
    reportFilePath: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: REPORT_EMAIL_STATUSES,
      default: 'pending',
      index: true,
    },
    emailMode: {
      type: String,
      enum: ['draft', 'send'],
      default: 'draft',
    },
    actionedAt: {
      type: Date,
    },
    actionedBy: {
      type: String,
      trim: true,
    },
    graphMessageId: {
      type: String,
      trim: true,
    },
    dryRun: {
      type: Boolean,
      default: false,
    },
    errorMessage: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

customerReportEmailSchema.index({ clientId: 1, complianceReportLogId: 1 }, { unique: true });

module.exports = mongoose.model('CustomerReportEmail', customerReportEmailSchema);
module.exports.REPORT_EMAIL_STATUSES = REPORT_EMAIL_STATUSES;
