const mongoose = require('mongoose');

// Singleton document (one row, queried via findOne()) — domain-specific
// ingestion metadata. The actual run-lock/double-guard mechanism reuses the
// existing generic SystemStatus + runGuardedProcess pattern (processKey:
// 'logiFormsIngest') rather than duplicating an isRunning flag here.
const pendingDropSchema = new mongoose.Schema(
  {
    collectionName: { type: String, required: true },
    droppedOldCollectionAt: { type: Date }, // when the collection this replaced was renamed aside
    dropAfter: { type: Date, required: true }, // 48h retention window (see logiFormsIngestService.js)
  },
  { _id: false }
);

const logiFormsIngestStatusSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['idle', 'checking', 'ingesting', 'ready', 'failed'],
      default: 'idle',
    },
    activeFileId: { type: String, default: null },
    activeFileName: { type: String, default: null },
    activeFileModifiedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    // Tracks the daily forced-recheck safety net (Phase 2) — separate from
    // lastCheckedAt, which updates on every hourly check regardless of
    // whether it was forced. Bumped whenever a force:true check actually
    // runs (whether from the daily safety net or the manual "Check Now"
    // button), so the two never redundantly force back-to-back.
    lastForcedRecheckAt: { type: Date, default: null },
    lastIngestStartedAt: { type: Date, default: null },
    lastIngestCompletedAt: { type: Date, default: null },
    totalRowsRead: { type: Number, default: null },
    uniqueRecordCount: { type: Number, default: null },
    skippedRowsCount: { type: Number, default: null },
    skippedRows: { type: [Object], default: undefined },
    lastError: { type: String, default: null },
    // 48-hour delayed-drop bookkeeping for the collection a successful swap
    // renamed aside (rollback safety) — a cron tick drops any entry whose
    // dropAfter has passed (see dropExpiredOldLogiFormsCollections).
    pendingDrops: { type: [pendingDropSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LogiFormsIngestStatus', logiFormsIngestStatusSchema);
