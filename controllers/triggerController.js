const { runAllFlows } = require('../services/runAllFlows');
const SystemStatus = require('../models/SystemStatus');

// GET /api/trigger-scan?secret=...
// Fire-and-forget: responds immediately (no HTTP timeout risk, no matter
// how long the actual processing takes), then kicks off runAllFlows() in
// the background AFTER the response has already been sent. The outcome is
// picked up later via GET /api/last-run-status, not from this response.
const triggerScan = async (req, res) => {
  const providedSecret = req.query.secret || req.headers['x-trigger-secret'];

  if (!process.env.TRIGGER_SECRET) {
    return res.status(500).json({ error: 'TRIGGER_SECRET is not configured on the server' });
  }

  if (!providedSecret || providedSecret !== process.env.TRIGGER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond first - the HTTP request ends here.
  res.json({ success: true, message: 'Scan started in background' });

  // Then run the actual work, independent of the (already-closed) HTTP
  // connection. Deliberately not awaited by the request handler.
  runAllFlows().catch((error) => {
    // runAllFlows() already catches per-flow errors internally and always
    // persists a SystemStatus result, so reaching here means something
    // outside those flows broke (e.g. the SystemStatus write itself, or a
    // programming error) - log it so it isn't silently swallowed.
    console.error('[TRIGGER-SCAN] runAllFlows() rejected unexpectedly:', error.message);
  });
};

// GET /api/last-run-status
// Returns the single SystemStatus document so callers can check "what
// happened last time" without waiting on a live run.
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
