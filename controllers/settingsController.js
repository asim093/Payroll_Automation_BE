const { getSettings, updateSettings } = require('../services/settingsService');
const { findLatestLogiFormsCsvInShareFile } = require('../services/sharefileService');
const { checkAndIngestLogiForms, getIngestStatus } = require('../services/logiFormsIngestService');
const { formatError } = require('../utils/formatError');

exports.getSettings = async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.status(200).json(settings);
  } catch (error) {
    next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const settings = await updateSettings(req.body);
    res.status(200).json(settings);
  } catch (error) {
    next(error);
  }
};

exports.getLogiFormsLatestFile = async (req, res) => {
  try {
    let folderPath = String(req.query.path || '').trim();
    if (!folderPath) {
      const settings = await getSettings();
      folderPath = String(settings.logiFormsFolderPath || '').trim();
    }
    if (!folderPath) {
      return res.status(200).json({ configured: false, file: null });
    }

    const latest = await findLatestLogiFormsCsvInShareFile(folderPath);
    return res.status(200).json({
      configured: true,
      file: latest ? { name: latest.fileName, modifiedAt: latest.modifiedAt } : null,
    });
  } catch (error) {
    return res.status(200).json({ configured: true, file: null, error: formatError(error) });
  }
};

// "Check Now" button (Settings > LogiForms) — same detection+ingestion code
// path as the hourly cron (checkAndIngestLogiForms), just force:true and
// user-triggered instead of interval-throttled. If a check/ingest is already
// running (cron or another click), runGuardedProcess's existing CAS lock
// makes this a no-op ({skipped: true}) rather than starting a second
// overlapping ingestion — surfaced to the caller as alreadyRunning.
exports.checkLogiFormsIngestNow = async (req, res, next) => {
  try {
    const result = await checkAndIngestLogiForms({ force: true });
    if (result?.skipped) {
      return res.status(200).json({ alreadyRunning: true, ...result });
    }
    res.status(200).json({ alreadyRunning: false, ...result });
  } catch (error) {
    next(error);
  }
};

exports.getLogiFormsIngestStatus = async (req, res, next) => {
  try {
    const status = await getIngestStatus();
    res.status(200).json(status || { status: 'idle' });
  } catch (error) {
    next(error);
  }
};
