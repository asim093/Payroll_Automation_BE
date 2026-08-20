const Settings = require('../models/Settings');
const SystemStatus = require('../models/SystemStatus');

const DEFAULT_INTERVAL_MINUTES = 5;

const isProcessDue = async (processKey, intervalSettingKey) => {
  const [settings, status] = await Promise.all([
    Settings.findOne().select(intervalSettingKey).lean(),
    SystemStatus.findOne().select(`${processKey}.lastRunAt`).lean(),
  ]);

  const intervalMinutes = Math.max(1, settings?.[intervalSettingKey] || DEFAULT_INTERVAL_MINUTES);
  const lastRunAt = status?.[processKey]?.lastRunAt;

  if (!lastRunAt) return { shouldRun: true };

  const elapsedMs = Date.now() - new Date(lastRunAt).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;

  if (elapsedMs >= intervalMs) return { shouldRun: true };

  return { shouldRun: false, minutesRemaining: Math.ceil((intervalMs - elapsedMs) / 60000) };
};

module.exports = { isProcessDue, DEFAULT_INTERVAL_MINUTES };
