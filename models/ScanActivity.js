const mongoose = require('mongoose');

// Single-document collection (same pattern as SystemStatus) tracking LIVE
// progress of whichever flow (delegated inbox / app-only inbox / ShareFile
// scan) is currently running inside runAllFlows() — this is what the
// dashboard's processing-status panel polls to show "X in queue, Y
// processing, Z done" in near-real-time (see services/scanActivityService.js
// and PUT-free GET /api/scan-activity).
//
// Deliberately separate from SystemStatus: that document is only written
// ONCE per scan cycle (at the very end), while this one is written on every
// single item processed — keeping them apart avoids the two write patterns
// fighting over the same document.
const scanActivitySchema = new mongoose.Schema(
  {
    isActive: {
      type: Boolean,
      default: false,
    },
    // Human-readable label for whichever of the 3 flows is currently
    // running, e.g. "Delegated Inbox Scan (Inbox + Junk)", "ShareFile Scan".
    phaseLabel: {
      type: String,
      trim: true,
      default: null,
    },
    totalItems: {
      type: Number,
      default: 0,
    },
    processedItems: {
      type: Number,
      default: 0,
    },
    // e.g. an email subject or a filename - whatever's being worked on right
    // now within the current phase. Null between items / when idle.
    currentItemLabel: {
      type: String,
      trim: true,
      default: null,
    },
    // When the CURRENT item started - used to flag "taking longer than
    // usual" (see controllers/scanActivityController.js, compared against
    // "now" at read-time, not stored as a duration).
    currentItemStartedAt: {
      type: Date,
      default: null,
    },
    phaseStartedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScanActivity', scanActivitySchema);
