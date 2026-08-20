const mongoose = require('mongoose');

// PHASE 5 — tracks files/folders found directly under the ShareFile
// account's root path (Settings' shareFileRootPath) whose name doesn't
// match any known client — populated by
// services/sharefileService.js's scanShareFileRootForUnmatchedItems(),
// which walks the ROOT folder itself (not any specific client's path) so it
// can catch things the normal per-client scan would never even look at.
const unmatchedShareFileItemSchema = new mongoose.Schema(
  {
    // ShareFile's own Item Id - unique so repeat scans update the existing
    // record (lastSeenAt) instead of creating duplicates.
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
    // Full path relative to the ShareFile ACCOUNT root (i.e. includes
    // shareFileRootPath), e.g. "Clients/Some New Folder" - shown as-is on
    // the Review Queue so it's obvious exactly where in ShareFile this is.
    path: {
      type: String,
      required: true,
      trim: true,
    },
    discoveredAt: {
      type: Date,
      default: Date.now,
    },
    // Refreshed (not re-created) every scan cycle the item is still seen
    // and still unresolved - lets a stale "last seen 3 weeks ago" entry be
    // told apart from one the master-scan still finds every 5 minutes.
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['unresolved', 'resolved', 'dismissed'],
      default: 'unresolved',
    },
    // Only meaningful for itemType 'folder' - whether it currently has
    // anything inside it. Refreshed on every scan (see
    // scanShareFileRootForUnmatchedItems()) so it always reflects the
    // folder's live state, not just what it looked like when first
    // discovered. Surfaced on the Review Queue so an empty folder (often
    // just a leftover from a client's path being changed) can be offered a
    // one-click delete instead of only "assign to a client".
    isEmpty: {
      type: Boolean,
      default: false,
    },
    // Set when resolved by assigning to a client (see
    // controllers/unmatchedShareFileItemController.js) - null for dismissed
    // items (dismissed = "not a client folder, stop flagging it" with no
    // client attached).
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
