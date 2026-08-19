const ScanActivity = require('../models/ScanActivity');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const { deriveScanActivityView } = require('../utils/scanActivityView');

// @desc    Live processing-status for the dashboard. PHASE 9: this is now
//          only used for the INITIAL load (and a self-heal refresh after a
//          WebSocket reconnect) — the frontend no longer polls this on an
//          interval, it listens for 'scan-activity' push-events instead
//          (see services/socketService.js). completedToday is computed
//          HERE ONLY (not on every WebSocket broadcast, which is a pure
//          DB-free computation — see utils/scanActivityView.js's own
//          comment) since this route is now called rarely (once per page
//          load/reconnect) rather than every few seconds.
// @route   GET /api/scan-activity
const getScanActivity = async (req, res, next) => {
  try {
    const activity = await ScanActivity.findOne();

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [emailsToday, filesToday] = await Promise.all([
      EmailLog.countDocuments({ status: 'processed', createdAt: { $gte: startOfToday } }),
      FileLog.countDocuments({ status: 'moved', processedAt: { $gte: startOfToday } }),
    ]);

    res.json({
      ...deriveScanActivityView(activity),
      completedToday: { emails: emailsToday, files: filesToday },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getScanActivity };
