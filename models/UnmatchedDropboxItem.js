const mongoose = require('mongoose');

const unmatchedDropboxItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    itemType: {
      type: String,
      enum: ['file', 'folder'],
      required: true,
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
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['unresolved', 'resolved', 'dismissed'],
      default: 'unresolved',
    },
    isEmpty: {
      type: Boolean,
      default: false,
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

module.exports = mongoose.model('UnmatchedDropboxItem', unmatchedDropboxItemSchema);
