require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');

(async () => {
  let failed = false;
  try {
    await connectDB();

    const { isProcessDue } = require('./services/scanThrottle');
    const due = await isProcessDue('shareFileBridge', 'shareFileBridgeIntervalMinutes');

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
  } catch (error) {
    failed = true;
    console.error('[RUN-SHAREFILE-BRIDGE] Unexpected error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('[RUN-SHAREFILE-BRIDGE] Connection closed, exiting.');
  }
  process.exit(failed ? 1 : 0);
})();
