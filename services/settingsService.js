const Settings = require('../models/Settings');

const DEFAULTS = {
  dropboxRootPath: 'WOTC',
  shareFileRootPath: 'Clients',
  outlookRootPath: 'Clients',
  mailSyncIntervalMinutes: 5,
  shareFileBridgeIntervalMinutes: 5,
};

// Floor matches the cron schedule itself (every 5 min - see render.yaml
// and models/Settings.js's own comment on why 5, not 1).
const clampIntervalMinutes = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(180, Math.max(5, Math.round(parsed)));
};


let cache = null;

const getSettings = async () => {
  if (cache) return cache;

  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create(DEFAULTS);
  }
  cache = settings;
  return settings;
};

const updateSettings = async (updates) => {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = new Settings(DEFAULTS);
  }

  if (updates.dropboxRootPath !== undefined) {
    settings.dropboxRootPath = updates.dropboxRootPath;
  }
  if (updates.shareFileRootPath !== undefined) {
    settings.shareFileRootPath = updates.shareFileRootPath;
  }
  if (updates.outlookRootPath !== undefined) {
    settings.outlookRootPath = updates.outlookRootPath;
  }
  if (updates.mailSyncIntervalMinutes !== undefined) {
    settings.mailSyncIntervalMinutes = clampIntervalMinutes(
      updates.mailSyncIntervalMinutes,
      settings.mailSyncIntervalMinutes
    );
  }
  if (updates.shareFileBridgeIntervalMinutes !== undefined) {
    settings.shareFileBridgeIntervalMinutes = clampIntervalMinutes(
      updates.shareFileBridgeIntervalMinutes,
      settings.shareFileBridgeIntervalMinutes
    );
  }

  await settings.save();
  cache = settings;
  return settings;
};

module.exports = { getSettings, updateSettings };
