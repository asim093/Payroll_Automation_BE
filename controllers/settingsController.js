const { getSettings, updateSettings } = require('../services/settingsService');

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
