const { runMailSyncOnce } = require('../services/mailSyncRunner');
const { runShareFileBridgeOnce } = require('../services/shareFileBridgeRunner');
const SystemStatus = require('../models/SystemStatus');

const PROCESS_RUNNERS = {
  mailSync: runMailSyncOnce,
  shareFileBridge: runShareFileBridgeOnce,
};

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
