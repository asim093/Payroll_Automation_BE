const ScanActivity = require('../models/ScanActivity');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const { deriveScanActivityView } = require('../utils/scanActivityView');

// @desc    Live processing-status for the dashboard, for BOTH processes at
//          once (see models/ScanActivity.js's per-processKey design). PHASE
//          9: this is now only used for the INITIAL load (and a self-heal
//          refresh after a WebSocket reconnect) — the frontend no longer
//          polls this on an interval, it listens for 'scan-activity'
//          push-events instead (see services/socketService.js).
//          completedToday is computed HERE ONLY (not on every WebSocket
//          broadcast, which is a pure DB-free computation — see
//          utils/scanActivityView.js's own comment) since this route is now
//          called rarely (once per page load/reconnect) rather than every
//          few seconds. Both processes share the same completedToday
//          numbers (today's totals across the whole app) — there's no
//          per-process split of "emails today" vs "files today" to make,
//          since each metric only ever belongs to one process anyway.
// @route   GET /api/scan-activity
const getScanActivity = async (req, res, next) => {
  try {
    const [mailSyncActivity, shareFileBridgeActivity] = await Promise.all([
      ScanActivity.findOne({ processKey: 'mailSync' }),
      ScanActivity.findOne({ processKey: 'shareFileBridge' }),
    ]);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [emailsToday, filesToday] = await Promise.all([
      EmailLog.countDocuments({ status: 'processed', createdAt: { $gte: startOfToday } }),
      FileLog.countDocuments({ status: 'moved', processedAt: { $gte: startOfToday } }),
    ]);
    const completedToday = { emails: emailsToday, files: filesToday };

    res.json({
      mailSync: { ...deriveScanActivityView(mailSyncActivity), completedToday },
      shareFileBridge: { ...deriveScanActivityView(shareFileBridgeActivity), completedToday },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getScanActivity };
