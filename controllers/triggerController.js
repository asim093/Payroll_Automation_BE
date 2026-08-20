const { runMailSyncOnce } = require('../services/mailSyncRunner');
const { runShareFileBridgeOnce } = require('../services/shareFileBridgeRunner');
const SystemStatus = require('../models/SystemStatus');

// @desc    Fire-and-forget: responds immediately (no HTTP timeout risk, no
//          matter how long the actual processing takes), then kicks off
//          BOTH processes in the background AFTER the response has already
//          been sent. The outcome is picked up later via
//          GET /api/last-run-status, not from this response.
//
//          PHASE-UI-8 — runs Mail Sync Engine and ShareFile Bridge in
//          PARALLEL now (Promise.allSettled, not sequential await) since
//          they're independent processes with independent locks - a
//          genuine speed win for the dashboard's "Scan Now" button on top
//          of the split itself (used to be sequential: delegated -> app-
//          only -> ShareFile, one after another).
//
//          Manual trigger always runs immediately regardless of each
//          process's configured interval (see Settings page) - the
//          interval only throttles the unattended cron ticks (see
//          services/scanThrottle.js); a human clicking "Scan Now" should
//          never be told "not due yet".
//
//          No secret here (unlike the internal notify-progress endpoint) -
//          this is meant to be called from the logged-in dashboard itself,
//          where a client-side secret couldn't be kept secret anyway.
//          Safe to call even while a run is already in progress - each
//          runner's own lock (see services/processRunner.js) just skips
//          that process's cycle rather than double-processing anything.
// @route   POST /api/trigger-scan
const triggerScan = async (req, res) => {
  res.json({ success: true, message: 'Scan started in background' });

  Promise.allSettled([runMailSyncOnce(), runShareFileBridgeOnce()]).then(([mailSync, shareFileBridge]) => {
    if (mailSync.status === 'rejected') {
      console.error('[TRIGGER-SCAN] Mail Sync rejected unexpectedly:', mailSync.reason?.message);
    }
    if (shareFileBridge.status === 'rejected') {
      console.error('[TRIGGER-SCAN] ShareFile Bridge rejected unexpectedly:', shareFileBridge.reason?.message);
    }
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
