require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { processShareFileScan } = require('./processShareFileScan');
const { endActivity } = require('./services/scanActivityService');

const DEFAULT_SINCE = '2026-08-26';

const parseSince = () => {
  const arg = process.argv.find((value) => value.startsWith('--since='));
  return arg ? arg.split('=')[1] : process.env.SHAREFILE_INGEST_SINCE_DATE || DEFAULT_SINCE;
};

(async () => {
  let failed = false;
  const since = parseSince();
  process.env.SHAREFILE_INGEST_SINCE_DATE = since;

  try {
    await connectDB();
    console.log(`[CATCH-UP] ShareFile file-level detection catch-up starting (since ${since}).`);
    console.log('[CATCH-UP] Matched-client files are copied to Dropbox; unmatched files are listed in Needs Review only.');

    const summary = await processShareFileScan({ since });

    console.log('\n[CATCH-UP] Completed. Summary:');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    failed = true;
    console.error('[CATCH-UP] Failed:', error.message);
  } finally {
    try {
      await endActivity('shareFileBridge');
    } catch (activityError) {
      console.error('[CATCH-UP] Could not clear scan activity (non-fatal):', activityError.message);
    }
    await mongoose.connection.close();
  }

  process.exit(failed ? 1 : 0);
})();
