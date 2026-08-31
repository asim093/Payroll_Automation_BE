const mongoose = require('mongoose');

const matchingRuleSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['exact_email', 'domain', 'notification_pattern', 'subject_keyword'],
      required: true,
    },
    value: {
      type: String,
      required: true,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      enum: ['legacy_sync', 'manual'],
      default: 'manual',
    },
    createdBy: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

matchingRuleSchema.index({ type: 1, value: 1 });

module.exports = mongoose.model('MatchingRule', matchingRuleSchema);
