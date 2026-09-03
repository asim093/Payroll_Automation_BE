const ScanErrorLog = require('../models/ScanErrorLog');

const MAX_ENTRIES_PER_BATCH = 50;
const MAX_RETAINED_PER_PROCESS = 500;

const recordScanErrors = async (processKey, errors) => {
  const list = (errors || []).filter(Boolean);
  if (list.length === 0) return;

  try {
    await ScanErrorLog.insertMany(
      list.slice(0, MAX_ENTRIES_PER_BATCH).map((entry) => ({
        processKey,
        scope: entry.scope ? String(entry.scope).slice(0, 500) : undefined,
        message: String(entry.message || entry).slice(0, 2000),
      })),
      { ordered: false }
    );

    const count = await ScanErrorLog.countDocuments({ processKey });
    if (count > MAX_RETAINED_PER_PROCESS) {
      const boundary = await ScanErrorLog.find({ processKey })
        .sort({ occurredAt: -1 })
        .skip(MAX_RETAINED_PER_PROCESS)
        .limit(1)
        .lean();
      if (boundary[0]) {
        await ScanErrorLog.deleteMany({ processKey, occurredAt: { $lte: boundary[0].occurredAt } });
      }
    }
  } catch (error) {
    console.error(`[SCAN ERROR LOG] Could not persist ${processKey} errors (non-fatal):`, error.message);
  }
};

module.exports = { recordScanErrors };
