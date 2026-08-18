const { getSettings, updateSettings } = require('../services/settingsService');

// @desc    Get current settings (creates a default document on first call)
// @route   GET /api/settings
exports.getSettings = async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.status(200).json(settings);
  } catch (error) {
    next(error);
  }
};

// @desc    Update settings (partial - only fields present in the body change)
// @route   PUT /api/settings
exports.updateSettings = async (req, res, next) => {
  try {
    const settings = await updateSettings(req.body);
    res.status(200).json(settings);
  } catch (error) {
    next(error);
  }
};
