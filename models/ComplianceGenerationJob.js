const mongoose = require('mongoose');

const jobResultSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    clientName: String,
    success: Boolean,
    totalEmployees: Number,
    completedCount: Number,
    incompleteCount: Number,
    emailStatus: String,
    logiFormsSkippedRows: { type: [Object], default: undefined },
    error: String,
  },
  { _id: false }
);

const complianceGenerationJobSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
      required: true,
    },
    clientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true }],
    total: { type: Number, required: true },
    results: { type: [jobResultSchema], default: [] },
    logiFormsWarnings: { type: [Object], default: [] },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

complianceGenerationJobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
complianceGenerationJobSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model('ComplianceGenerationJob', complianceGenerationJobSchema);
