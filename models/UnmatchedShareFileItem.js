const mongoose = require('mongoose');

const unmatchedShareFileItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    path: {
      type: String,
      required: true,
      trim: true,
    },
    discoveredAt: {
      type: Date,
      default: Date.now,
    },
    sourceCreatedAt: {
      type: Date,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['unresolved', 'resolved', 'dismissed'],
      default: 'unresolved',
    },
    resolvedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
    resolvedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UnmatchedShareFileItem', unmatchedShareFileItemSchema);
