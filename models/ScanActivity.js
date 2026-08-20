const mongoose = require('mongoose');

// Live progress of whichever of the app's two independent processes (Mail
// Sync Engine / ShareFile Bridge - see services/mailSyncRunner.js and
// shareFileBridgeRunner.js) is currently running — this is what the
// dashboard's Process Cards poll/subscribe to for near-real-time "X in
// queue, Y processing, Z done" (see services/scanActivityService.js and
// GET /api/scan-activity).
//
// PHASE-UI-8 — used to be a true singleton (one document, no key) back
// when only one flow could ever be active at a time (they all ran
// sequentially inside one job). Now that Mail Sync Engine and ShareFile
// Bridge are independent cron jobs that can genuinely run at the same
// moment, EACH gets its own document (processKey unique-indexed) so their
// live progress can never clobber each other - at most 2 documents ever
// exist in this collection.
//
// Deliberately separate from SystemStatus: that document is only written
// ONCE per run (at the very end), while this one is written on every
// single item processed — keeping them apart avoids the two write patterns
// fighting over the same document.
const scanActivitySchema = new mongoose.Schema(
  {
    processKey: {
      type: String,
      enum: ['mailSync', 'shareFileBridge'],
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    // Human-readable label for whatever this process is doing right now,
    // e.g. "Delegated Inbox Scan (Inbox + Junk)", "ShareFile Scan".
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
