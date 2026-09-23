require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');


const isForced = () => process.argv.includes('--force') || process.env.FORCE_RUN === 'true';

(async () => {
  let failed = false;
  try {
    await connectDB();

    const forced = isForced();
    let due;
    if (forced) {
      console.log('[RUN-SHAREFILE-BRIDGE] --force/FORCE_RUN set - bypassing the time-throttle check.');
      due = { shouldRun: true };
    } else {
      const { isProcessDue } = require('./services/scanThrottle');
      due = await isProcessDue('shareFileBridge', 'shareFileBridgeIntervalMinutes');
    }

    if (!due.shouldRun) {
      console.log(`[RUN-SHAREFILE-BRIDGE] Not due yet (~${due.minutesRemaining} min remaining) - skipping.`);
    } else {
      const { runShareFileBridgeOnce } = require('./services/shareFileBridgeRunner');
      const result = await runShareFileBridgeOnce();

      if (result?.skipped) {
        console.log('[RUN-SHAREFILE-BRIDGE] Skipped - a previous run was still in progress.');
      } else if (result?.success === false) {
        console.error('[RUN-SHAREFILE-BRIDGE] Run failed - see errors above.');
        failed = true;
      } else {
        console.log('[RUN-SHAREFILE-BRIDGE] Completed successfully.');
      }
    }

    // Piggybacks on this same cron tick rather than its own Render cron
    // service — no new process/billing to maintain. This is independent of
    // the shareFileBridge due-check above (it has its own ~60-min throttle
    // via isProcessDue('logiFormsIngest', ...) inside runScheduledLogiFormsCheck),
    // so it runs on every tick attempt regardless of whether shareFileBridge
    // itself was due this time; most ticks it will just no-op until its own
    // interval has elapsed.
    try {
      const { runScheduledLogiFormsCheck } = require('./services/logiFormsIngestService');
      const logiFormsResult = await runScheduledLogiFormsCheck();
      if (logiFormsResult?.skipped) {
        console.log(`[RUN-SHAREFILE-BRIDGE] LogiForms check: not due yet (~${logiFormsResult.minutesRemaining} min remaining).`);
      } else if (logiFormsResult?.success === false) {
        console.error(`[RUN-SHAREFILE-BRIDGE] LogiForms check failed: ${logiFormsResult.error}`);
      } else {
        console.log(`[RUN-SHAREFILE-BRIDGE] LogiForms check completed:`, JSON.stringify(logiFormsResult));
      }
    } catch (error) {
      console.error('[RUN-SHAREFILE-BRIDGE] LogiForms check unexpected error:', error.message);
    }
  } catch (error) {
    failed = true;
    console.error('[RUN-SHAREFILE-BRIDGE] Unexpected error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('[RUN-SHAREFILE-BRIDGE] Connection closed, exiting.');
  }
  process.exit(failed ? 1 : 0);
})();
