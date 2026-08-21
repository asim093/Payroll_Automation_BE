const mongoose = require('mongoose');

const reviewQueueSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['email', 'file'],
      required: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    reason: {
      type: String,
      enum: ['unknown_sender', 'no_match', 'ambiguous', 'client_inactive', 'new_sender_domain_match'],
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    resolvedBy: {
      type: String,
      trim: true,
    },
    resolvedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
    suggestedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReviewQueue', reviewQueueSchema);
