const { getSettings, updateSettings } = require('../services/settingsService');
const { findLatestLogiFormsCsvInShareFile } = require('../services/sharefileService');
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
