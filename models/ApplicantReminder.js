const mongoose = require('mongoose');

const REMINDER_STATUSES = [
  'pending',
  'draft_created',
  'skipped_no_email',
  'skipped_no_form_url',
  'failed',
  'superseded',
];

const INCOMPLETE_KINDS = ['no_logiforms_record', 'unrecognized_status'];

const applicantReminderSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    complianceRunAt: {
      type: Date,
    },
    employeeName: {
      type: String,
      trim: true,
    },
    employeeSsnHash: {
      type: String,
      required: true,
    },
    employeeSsnLast4: {
      type: String,
      trim: true,
    },
    employeeEmail: {
      type: String,
      trim: true,
      default: '',
    },
    hireDate: {
      type: Date,
    },
    weekEndingDate: {
      type: Date,
    },
    logiformsStatusAtRun: {
      type: String,
      trim: true,
    },
    incompleteKind: {
      type: String,
      enum: INCOMPLETE_KINDS,
    },
    reminderStatus: {
      type: String,
      enum: REMINDER_STATUSES,
      default: 'pending',
      index: true,
    },
    reminderMode: {
      type: String,
      enum: ['draft'],
      default: 'draft',
    },
    reminderActionedAt: {
      type: Date,
    },
    reminderActionedBy: {
      type: String,
      trim: true,
    },
    graphDraftId: {
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

applicantReminderSchema.index({ clientId: 1, employeeSsnHash: 1 }, { unique: true });

module.exports = mongoose.model('ApplicantReminder', applicantReminderSchema);
module.exports.REMINDER_STATUSES = REMINDER_STATUSES;
module.exports.INCOMPLETE_KINDS = INCOMPLETE_KINDS;
