const mongoose = require('mongoose');

const ignoreRuleSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['email', 'sharefile', 'dropbox'],
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['sender_email', 'sender_domain', 'folder_path'],
      required: true,
    },
    action: {
      type: String,
      enum: ['ignore', 'assign'],
      default: 'ignore',
      index: true,
    },
    value: {
      type: String,
      required: true,
      trim: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
    label: {
      type: String,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

ignoreRuleSchema.index({ scope: 1, type: 1, value: 1, action: 1 }, { unique: true });

module.exports = mongoose.model('IgnoreRule', ignoreRuleSchema);
