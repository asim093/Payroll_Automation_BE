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
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
