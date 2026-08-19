const { broadcastScanActivity } = require('../services/socketService');
const { deriveScanActivityView } = require('../utils/scanActivityView');

// @desc    PHASE 9 — receives a progress-tick from whichever process is
//          actually running the scan (scheduler.js or runScanOnce.js —
//          see services/scanActivityService.js's notify()), which may be a
//          totally separate process/container from this web service (that
//          is the whole reason this endpoint exists at all — see the
//          Phase 9 architecture note: a Render Cron Job container can't
//          hold a WebSocket connection open to broadcast from directly).
//          Turns it into a WebSocket broadcast to every connected
//          dashboard.
//
//          Protected by a shared secret (never a public/guessable route) —
//          this is a WRITE-adjacent endpoint (triggers a broadcast to every
//          connected client) even though it doesn't touch the DB itself, so
//          it isn't left open the way a read-only GET might be.
// @route   POST /internal/notify-progress
// @body    raw ScanActivity fields: { isActive, phaseLabel, totalItems,
//          processedItems, currentItemLabel, currentItemStartedAt }
const notifyProgress = (req, res) => {
  const providedSecret = req.headers['x-internal-secret'];

  if (!process.env.INTERNAL_NOTIFY_SECRET) {
    return res.status(500).json({ error: 'INTERNAL_NOTIFY_SECRET is not configured on this server' });
  }
  if (!providedSecret || providedSecret !== process.env.INTERNAL_NOTIFY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Deliberately synchronous/no DB access - see deriveScanActivityView()'s
  // own comment for why (this endpoint can be called quite frequently
  // during an active scan, even after throttling on the sending side).
  const view = deriveScanActivityView(req.body);
  broadcastScanActivity(view);

  res.status(200).json({ received: true });
};

module.exports = { notifyProgress };
