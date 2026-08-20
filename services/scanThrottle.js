/**
 * PHASE-UI-8 (+ UI-9) — optimization layer for the split-cron design. Both
 * Mail Sync Engine and ShareFile Bridge run on a Render Cron Job schedule
 * of every 5 minutes (see render.yaml), so their
 * configured interval (Settings.mailSyncIntervalMinutes /
 * shareFileBridgeIntervalMinutes, editable from the Settings page with no
 * redeploy needed) can be RAISED above 5 minutes without a redeploy - 5
 * minutes is the floor either way, since that's how often the cron itself
 * ticks. (This used to fire every minute so the floor could reach 1 - see
 * render.yaml's own comment on why that was reverted: unreliable env-var
 * injection into that-frequent cron containers, plus meaningfully more
 * Render compute cost for no real benefit at this app's scale.)
 *
 * Deliberately kept dependency-light (only the 2 small Mongoose models
 * below) and called BEFORE either entry script (runMailSyncOnce.js /
 * runShareFileBridgeOnce.js) requires any of the actual flow-processing
 * modules (Graph/Dropbox/ShareFile SDKs, emailProcessor, etc.) - most
 * invocations are just this one cheap check-and-exit, so the heavy modules
 * should only ever get loaded into memory on the (usually 1-in-N)
 * invocation that's actually due to do real work.
 */
const Settings = require('../models/Settings');
const SystemStatus = require('../models/SystemStatus');

const DEFAULT_INTERVAL_MINUTES = 5;

// @param processKey - 'mailSync' | 'shareFileBridge'
// @param intervalSettingKey - the matching Settings field name
//   ('mailSyncIntervalMinutes' | 'shareFileBridgeIntervalMinutes')
const isProcessDue = async (processKey, intervalSettingKey) => {
  // .select() + .lean() - only the one field each document actually needs
  // to answer "is it time yet", not the full documents (SystemStatus in
  // particular can carry a sizeable lastRunResult blob per process).
  const [settings, status] = await Promise.all([
    Settings.findOne().select(intervalSettingKey).lean(),
    SystemStatus.findOne().select(`${processKey}.lastRunAt`).lean(),
  ]);

  // Floor of 5 matches the cron schedule itself - see this file's own
  // top comment for why.
  const intervalMinutes = Math.max(5, settings?.[intervalSettingKey] || DEFAULT_INTERVAL_MINUTES);
  const lastRunAt = status?.[processKey]?.lastRunAt;

  if (!lastRunAt) return { shouldRun: true };

  const elapsedMs = Date.now() - new Date(lastRunAt).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;

  if (elapsedMs >= intervalMs) return { shouldRun: true };

  return { shouldRun: false, minutesRemaining: Math.ceil((intervalMs - elapsedMs) / 60000) };
};

module.exports = { isProcessDue, DEFAULT_INTERVAL_MINUTES };
