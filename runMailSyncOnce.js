
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
      console.log('[RUN-MAIL-SYNC] --force/FORCE_RUN set - bypassing the time-throttle check.');
      due = { shouldRun: true };
    } else {
      const { isProcessDue } = require('./services/scanThrottle');
      due = await isProcessDue('mailSync', 'mailSyncIntervalMinutes');
    }

    if (!due.shouldRun) {
      console.log(`[RUN-MAIL-SYNC] Not due yet (~${due.minutesRemaining} min remaining) - skipping.`);
    } else {
      const { runMailSyncOnce } = require('./services/mailSyncRunner');
      const result = await runMailSyncOnce();

      if (result?.skipped) {
        console.log('[RUN-MAIL-SYNC] Skipped - a previous run was still in progress.');
      } else if (result?.success === false) {
        console.error('[RUN-MAIL-SYNC] Run failed - see errors above.');
        failed = true;
      } else {
        console.log('[RUN-MAIL-SYNC] Completed successfully.');
      }
    }
  } catch (error) {
    failed = true;
    console.error('[RUN-MAIL-SYNC] Unexpected error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('[RUN-MAIL-SYNC] Connection closed, exiting.');
  }
  process.exit(failed ? 1 : 0);
})();
