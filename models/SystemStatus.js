const mongoose = require('mongoose');

// Single-document collection: tracks only the MOST RECENT run of
// runAllFlows() (whether triggered by the cron scheduler or by the
// on-demand /api/trigger-scan endpoint). We don't need a full run-history
// log here — just "what happened last time" for the dashboard / manual
// checks — so this is always upserted onto one document rather than
// growing a new row per run.
const systemStatusSchema = new mongoose.Schema(
  {
    lastRunAt: {
      type: Date,
    },
    // Per-flow breakdown (delegatedFlow / appOnlyFlow / shareFileScan),
    // each with its own success flag and summary/error - see
    // services/runAllFlows.js. Stored as Mixed since the shape is a plain
    // results object, not something we query into.
    lastRunResults: {
      type: mongoose.Schema.Types.Mixed,
    },
    lastRunSuccess: {
      type: Boolean,
    },
    // Delta-fetch watermark for email-scanning (see runAllFlows.js /
    // graphService.getRecentEmails) — replaces the old isRead:false filter,
    // which permanently missed any email a user opened before our scan ran.
    // Only advanced after a scan cycle completes WITHOUT error, so a failed
    // cycle re-covers the same window next time instead of silently
    // skipping it. Shared by both the delegated and app-only flows (one
    // watermark, not two) since they poll the same underlying timeline.
    lastEmailScanAt: {
      type: Date,
    },
    // Cron-overlap guard (see runAllFlows.js) — set true right before a
    // scan cycle's email flows start, false again once they finish
    // (success or error, via try/finally). If a cycle finds this already
    // true and emailScanStartedAt is recent, it skips itself instead of
    // running a second scan concurrently with the first (which could
    // double-process the same emails - see the race-condition analysis
    // that led to this fix).
    isEmailScanRunning: {
      type: Boolean,
      default: false,
    },
    // When the current (or most recent) lock was acquired. Used to detect
    // a STALE lock — if a previous run crashed without reaching its
    // finally-block, isEmailScanRunning would stay stuck at true forever
    // without this: a lock older than the staleness threshold is treated
    // as abandoned and overridden rather than blocking every future cycle.
    emailScanStartedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
