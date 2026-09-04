const mongoose = require('mongoose');

const weeklyBreakdownEntrySchema = new mongoose.Schema(
  {
    weekEndingDate: {
      type: Date,
    },
    total: {
      type: Number,
      required: true,
    },
    completed: {
      type: Number,
      required: true,
    },
    incomplete: {
      type: Number,
      required: true,
    },
    completedPercentage: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const complianceReportLogSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    reportType: {
      type: String,
      enum: ['Admin', 'Client'],
      required: true,
    },
    filePath: {
      type: String,
      trim: true,
    },
    totalEmployees: {
      type: Number,
    },
    completedCount: {
      type: Number,
    },
    incompleteCount: {
      type: Number,
    },
    emailStatus: {
      type: String,
      enum: ['Draft-Created', 'Sent', 'Failed', 'Skipped-No-Email'],
    },
    success: {
      type: Boolean,
      required: true,
    },
    errorMessage: {
      type: String,
      trim: true,
    },
    weeklyBreakdown: {
      type: [weeklyBreakdownEntrySchema],
      default: undefined,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ComplianceReportLog', complianceReportLogSchema);
