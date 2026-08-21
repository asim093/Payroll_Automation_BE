const ScanActivity = require('../models/ScanActivity');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const { deriveScanActivityView } = require('../utils/scanActivityView');

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
