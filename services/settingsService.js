const Settings = require('../models/Settings');

const DEFAULTS = {
  dropboxPathTemplate: 'WOTC/{Client Name}/Payroll Files',
  shareFilePathTemplate: 'Clients/{Client Name}',
  outlookPathTemplate: 'Clients/{Client Name}',
};

// Simple in-memory cache — dropboxService.js reads this on every single
// upload and sharefileService.js on every scan, so hitting MongoDB each
// time just to read a couple of short strings would be wasteful. The cache
// is refreshed by updateSettings() whenever the admin saves a change via
// PUT /api/settings, so a running process picks up a new template on its
// very next file without needing a restart.
let cache = null;

// @desc Returns the current settings document, creating one with the
//       default templates on first-ever call if none exists yet.
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

  if (updates.dropboxPathTemplate !== undefined) {
    settings.dropboxPathTemplate = updates.dropboxPathTemplate;
  }
  if (updates.shareFilePathTemplate !== undefined) {
    settings.shareFilePathTemplate = updates.shareFilePathTemplate;
  }
  if (updates.outlookPathTemplate !== undefined) {
    settings.outlookPathTemplate = updates.outlookPathTemplate;
  }

  await settings.save();
  cache = settings;
  return settings;
};

module.exports = { getSettings, updateSettings };
