const { runMailSyncOnce } = require('../services/mailSyncRunner');
const { runShareFileBridgeOnce } = require('../services/shareFileBridgeRunner');
const SystemStatus = require('../models/SystemStatus');

// PHASE-UI-10 — "Scan Now" moved from one global navbar button (which fired
// BOTH processes together) to a per-process button on each Process Card,
// matching the split-cron architecture: each process is independently
// triggerable now, same as it's independently scheduled/locked.
const PROCESS_RUNNERS = {
  mailSync: runMailSyncOnce,
  shareFileBridge: runShareFileBridgeOnce,
};

// @desc    Fire-and-forget: responds immediately (no HTTP timeout risk, no
//          matter how long the actual processing takes), then kicks off
//          the ONE requested process in the background AFTER the response
//          has already been sent. The outcome is picked up later via
//          GET /api/last-run-status / the scan-activity WebSocket feed,
//          not from this response.
//
//          Manual trigger always runs immediately regardless of this
//          process's configured interval (see Settings page) - the
//          interval only throttles the unattended cron ticks (see
//          services/scanThrottle.js); a human clicking "Scan Now" should
//          never be told "not due yet".
//
//          No secret here (unlike the internal notify-progress endpoint) -
//          this is meant to be called from the logged-in dashboard itself,
//          where a client-side secret couldn't be kept secret anyway.
//          Safe to call even while this process is already running - its
//          own lock (see services/processRunner.js) just skips this cycle
//          rather than double-processing anything.
// @route   POST /api/trigger-scan
// @body    { processKey: 'mailSync' | 'shareFileBridge' }
const triggerScan = async (req, res) => {
  const { processKey } = req.body || {};
  const runner = PROCESS_RUNNERS[processKey];

  if (!runner) {
    return res.status(400).json({ error: 'processKey must be "mailSync" or "shareFileBridge"' });
  }

  res.json({ success: true, message: 'Scan started in background' });

  runner().catch((error) => {
    console.error(`[TRIGGER-SCAN] ${processKey} rejected unexpectedly:`, error.message);
  });
};

// @desc    GET /api/last-run-status
// Returns the single SystemStatus document (now { mailSync, shareFileBridge,
// lastEmailScanAt } - see that model) so callers can check "what happened
// last time" for each process without waiting on a live run. Used by the
// dashboard's Overview page (SystemStatusBanner + ProcessCardsPanel).
const getLastRunStatus = async (req, res, next) => {
  try {
    const status = await SystemStatus.findOne().sort({ updatedAt: -1 });

    if (!status) {
      return res.json({ mailSync: {}, shareFileBridge: {}, lastEmailScanAt: null });
    }

    res.json(status);
  } catch (error) {
    next(error);
  }
};

module.exports = { triggerScan, getLastRunStatus };
