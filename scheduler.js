require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { isProcessDue } = require('./services/scanThrottle');
const { runMailSyncOnce } = require('./services/mailSyncRunner');
const { runShareFileBridgeOnce } = require('./services/shareFileBridgeRunner');
const { retryPendingFolderSetups } = require('./services/folderSetupRetryService');
const { runScheduledLogiFormsCheck } = require('./services/logiFormsIngestService');

const TICK_SCHEDULE = '*/5 * * * *';
const LOGIFORMS_TICK_SCHEDULE = '*/15 * * * *';

const runIfDue = async (label, processKey, intervalSettingKey, run) => {
  const due = await isProcessDue(processKey, intervalSettingKey);
  if (!due.shouldRun) {
    console.log(`[SCHEDULER] ${label}: not due yet (~${due.minutesRemaining} min remaining).`);
    return;
  }
  const result = await run();
  if (result?.skipped) {
    console.log(`[SCHEDULER] ${label}: skipped (previous run still in progress).`);
  } else if (result?.success === false) {
    console.error(`[SCHEDULER] ${label}: run failed - see errors above.`);
  } else {
    console.log(`[SCHEDULER] ${label}: completed successfully.`);
  }
};

const tick = async () => {
  await Promise.allSettled([
    runIfDue('Mail Sync Engine', 'mailSync', 'mailSyncIntervalMinutes', runMailSyncOnce),
    runIfDue('ShareFile Bridge', 'shareFileBridge', 'shareFileBridgeIntervalMinutes', runShareFileBridgeOnce),
  ]);

  try {
    await retryPendingFolderSetups();
  } catch (error) {
    console.error(`[SCHEDULER] Folder-setup retry failed: ${error.message}`);
  }
};

// Runs on its OWN schedule/timer, entirely independent of tick() above — a
// real ~10-minute LogiForms ingestion must never delay or block mail-sync/
// ShareFile-bridge's own 5-minute cadence (see runLogiFormsIngestOnly.js for
// the same reasoning on the production Render-cron side). Its own ~60-min
// throttle (isProcessDue('logiFormsIngest', ...) inside
// runScheduledLogiFormsCheck) is what actually enforces the real interval,
// so most of these 15-minute ticks just no-op.
const logiFormsTick = async () => {
  try {
    const result = await runScheduledLogiFormsCheck();
    if (!result?.skipped) {
      console.log(`[SCHEDULER] LogiForms check: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error(`[SCHEDULER] LogiForms check failed: ${error.message}`);
  }
};

const start = async () => {
  await connectDB();

  console.log(`[SCHEDULER] Started. Checking mail-sync/ShareFile-bridge every 5 minutes (cron: "${TICK_SCHEDULE}").`);
  console.log(`[SCHEDULER] Checking LogiForms independently every 15 minutes (cron: "${LOGIFORMS_TICK_SCHEDULE}").`);
  console.log('[SCHEDULER] Each process only does real work once its own Settings-configured interval has elapsed.');
  console.log('[SCHEDULER] Press Ctrl+C to stop.');

  await tick();
  cron.schedule(TICK_SCHEDULE, tick);

  await logiFormsTick();
  cron.schedule(LOGIFORMS_TICK_SCHEDULE, logiFormsTick);
};

start();

process.on('SIGINT', async () => {
  console.log('\n[SCHEDULER] Stopping (SIGINT received)...');
  await mongoose.connection.close();
  process.exit(0);
});
