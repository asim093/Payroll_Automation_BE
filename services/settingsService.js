const Settings = require('../models/Settings');

const DEFAULTS = {
  dropboxRootPath: 'WOTC',
  shareFileRootPath: 'Clients',
  outlookRootPath: 'Clients',
};

// Simple in-memory cache — dropboxService.js reads this on every single
// upload and sharefileService.js on every scan, so hitting MongoDB each
// time just to read a couple of short strings would be wasteful. The cache
// is refreshed by updateSettings() whenever the admin saves a change via
// PUT /api/settings, so a running process picks up a new root path on its
// very next file without needing a restart.
let cache = null;

// @desc Returns the current settings document, creating one with the
//       default root paths on first-ever call if none exists yet.
const getSettings = async () => {
  if (cache) return cache;

  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create(DEFAULTS);
  }
  cache = settings;
  return settings;
};

// @desc Applies partial updates (only fields present in `updates` are
//       changed) and refreshes the cache.
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

  await settings.save();
  cache = settings;
  return settings;
};

module.exports = { getSettings, updateSettings };
