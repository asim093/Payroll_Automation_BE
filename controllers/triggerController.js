const { runAllFlows } = require('../services/runAllFlows');
const SystemStatus = require('../models/SystemStatus');

// @desc    Fire-and-forget: responds immediately (no HTTP timeout risk, no
//          matter how long the actual processing takes), then kicks off
//          runAllFlows() in the background AFTER the response has already
//          been sent. The outcome is picked up later via
//          GET /api/last-run-status, not from this response.
//
//          NOTE: brought back for the dashboard's "Scan Now" button (top
//          navbar) - a DIFFERENT purpose than the old Phase-8-removed
//          version of this endpoint, which existed only so an external
//          pinger (cron-job.org) could hit it on a schedule with a shared
//          secret. This one is meant to be called from the logged-in
//          dashboard itself, where a client-side secret couldn't be kept
//          secret anyway (it'd be sitting in the browser's JS) - so no
//          secret here. Consistent with the rest of this API right now:
//          Phase 10's dummy-auth only gates the FRONTEND's routes, not the
//          backend API itself (see backend/controllers/authController.js's
//          top comment) - this endpoint isn't a new gap, it matches every
//          other route's current (lack of) protection.
//
//          Safe to call even while a scan is already running - runAllFlows()
//          itself checks the isEmailScanRunning DB lock and just skips that
//          cycle rather than double-processing anything (see
//          services/runAllFlows.js).
// @route   POST /api/trigger-scan
const triggerScan = async (req, res) => {
  res.json({ success: true, message: 'Scan started in background' });

  runAllFlows().catch((error) => {
    // runAllFlows() already catches per-flow errors internally and always
    // persists a SystemStatus result, so reaching here means something
    // outside those flows broke (e.g. the SystemStatus write itself, or a
    // programming error) - log it so it isn't silently swallowed.
    console.error('[TRIGGER-SCAN] runAllFlows() rejected unexpectedly:', error.message);
  });
};

// @desc    GET /api/last-run-status
// Returns the single SystemStatus document so callers can check "what
// happened last time" without waiting on a live run. Used by the
// dashboard's Overview page (SystemStatusBanner).
const getLastRunStatus = async (req, res, next) => {
  try {
    const status = await SystemStatus.findOne().sort({ updatedAt: -1 });

    if (!status) {
      return res.json({ lastRunAt: null, lastRunResults: null, lastRunSuccess: null });
    }

    res.json(status);
  } catch (error) {
    next(error);
  }
};

module.exports = { triggerScan, getLastRunStatus };
