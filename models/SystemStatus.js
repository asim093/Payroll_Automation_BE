const mongoose = require('mongoose');

// PHASE-UI-8 — per-process run tracking. Used to be flat fields covering
// ALL THREE flows combined (one shared "isEmailScanRunning" lock, one
// shared "lastRunAt"), from back when they all ran sequentially inside one
// job (see services/runAllFlows.js, now removed). Mail Sync Engine and
// ShareFile Bridge are now two fully independent cron jobs (their own
// Render Cron Job service each — see render.yaml) that can genuinely run
// concurrently, so each needs its own lock/last-run record, not a shared
// one - two processes racing to write the same flat fields was exactly the
// bug this schema exists to avoid.
const processRunSchema = new mongoose.Schema(
  {
    lastRunAt: {
      type: Date,
      default: null,
    },
    // Whatever runMailSyncOnce()/runShareFileBridgeOnce() returned (see
    // services/mailSyncRunner.js / shareFileBridgeRunner.js) - a plain
    // results object, not something queried into, so Mixed is fine here.
    lastRunResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    lastRunSuccess: {
      type: Boolean,
      default: null,
    },
    // Cron-overlap guard (see services/processRunner.js) — set true right
    // before this process's own run starts, false again once it finishes
    // (success or error, via try/finally). A second cron tick for the SAME
    // process finding this already true skips itself instead of running
    // concurrently with itself (this does NOT prevent the OTHER process
    // from running at the same time - that's the whole point of splitting).
    isRunning: {
      type: Boolean,
      default: false,
    },
    // When the current (or most recent) lock was acquired - used to detect
    // a STALE lock left behind by a crashed run (see processRunner.js's
    // staleness threshold), the same safety-net the old single-lock design
    // had.
    runStartedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const systemStatusSchema = new mongoose.Schema(
  {
    mailSync: {
      type: processRunSchema,
      default: () => ({}),
    },
    shareFileBridge: {
      type: processRunSchema,
      default: () => ({}),
    },
    // Delta-fetch watermark for email-scanning (see mailSyncRunner.js /
    // graphService.getRecentEmails) — replaces the old isRead:false filter,
    // which permanently missed any email a user opened before our scan ran.
    // Mail-Sync-specific (ShareFile Bridge never used this).
    lastEmailScanAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
