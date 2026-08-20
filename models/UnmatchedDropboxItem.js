const mongoose = require('mongoose');

// Dropbox counterpart of models/UnmatchedShareFileItem.js — same shape,
// same purpose (files/folders found directly under Settings' dropboxRootPath
// whose name doesn't match any known client), populated by
// services/dropboxService.js's scanDropboxRootForUnmatchedItems(). Kept as
// its own model rather than generalizing UnmatchedShareFileItem into a
// source-agnostic one, since Dropbox and ShareFile identify/address items
// differently (a stable "id:..." string vs a REST item Id) and this avoids
// touching the already-working ShareFile pipeline at all.
const unmatchedDropboxItemSchema = new mongoose.Schema(
  {
    // Dropbox's own stable id (the "id:xxxxx" field on every file/folder
    // metadata entry) - stays the same across renames/moves, unlike the
    // path, so repeat scans update the existing record instead of
    // creating duplicates.
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
    // Dropbox's own path_display, e.g. "/Clients/Some New Folder".
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
    // Only meaningful for itemType 'folder' - see
    // UnmatchedShareFileItem.isEmpty's own comment, same purpose here.
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
