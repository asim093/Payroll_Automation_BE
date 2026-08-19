require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { runAllFlows } = require('./services/runAllFlows');

(async () => {
  let failed = false;
  try {
    await connectDB();
    const result = await runAllFlows();

    if (result?.skipped) {
      console.log('[RUN-SCAN-ONCE] Skipped this run - previous scan was still in progress (see the lock in runAllFlows.js).');
    } else if (result?.overallSuccess === false) {
   
      console.error('[RUN-SCAN-ONCE] One or more flows failed this run - see errors above.');
      failed = true;
    } else {
      console.log('[RUN-SCAN-ONCE] Completed successfully.');
    }
  } catch (error) {
    failed = true;
    console.error('[RUN-SCAN-ONCE] Unexpected error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('[RUN-SCAN-ONCE] Connection closed, exiting.');
  }
  process.exit(failed ? 1 : 0);
})();
