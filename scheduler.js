/**
 * PHASE-UI-8 (+ UI-9) — optional alternative to Render's native Cron Job
 * services (see render.yaml's payroll-automation-mail-sync /
 * -sharefile-bridge) for running both processes from a single
 * continuously-resident host instead (e.g. local dev, or any host that
 * isn't Render). NOT wired into server.js/package.json - run manually with
 * `node scheduler.js` if this deployment shape is what you want.
 *
 * Mirrors render.yaml's design as closely as it can from inside one
 * process: an in-process node-cron tick every 5 minutes (matching
 * render.yaml's own floor - see that file's comment on why 5, not a
 * shorter interval), each tick checking BOTH processes' own configured
 * interval (Settings.mailSyncIntervalMinutes /
 * shareFileBridgeIntervalMinutes - see services/scanThrottle.js) and
 * running whichever one is actually due, in parallel with each other (they
 * have independent locks - see services/processRunner.js - so this is safe
 * even if both happen to be due on the same tick).
 */
require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { isProcessDue } = require('./services/scanThrottle');
const { runMailSyncOnce } = require('./services/mailSyncRunner');
const { runShareFileBridgeOnce } = require('./services/shareFileBridgeRunner');

const TICK_SCHEDULE = '*/5 * * * *'; // every 5 minutes - matches render.yaml's floor

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
};

const start = async () => {
  await connectDB();

  console.log(`[SCHEDULER] Started. Checking both processes every 5 minutes (cron: "${TICK_SCHEDULE}").`);
  console.log('[SCHEDULER] Each process only does real work once its own Settings-configured interval has elapsed.');
  console.log('[SCHEDULER] Press Ctrl+C to stop.');

  await tick();
  cron.schedule(TICK_SCHEDULE, tick);
};

start();

process.on('SIGINT', async () => {
  console.log('\n[SCHEDULER] Stopping (SIGINT received)...');
  await mongoose.connection.close();
  process.exit(0);
});
