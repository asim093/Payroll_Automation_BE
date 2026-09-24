require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');

const isForced = () => process.argv.includes('--force') || process.env.FORCE_RUN === 'true';

// Standalone Render cron (own service, own schedule) — deliberately NOT
// piggybacked onto the ShareFile-bridge cron. A real LogiForms ingestion can
// take ~10 minutes; Render crons don't overlap their own runs, so tacking
// this onto another cron's script would stall THAT cron's own schedule for
// the whole ~10 minutes every time a new file is detected. Render's cron
// timeout is a fixed 12-hour default (confirmed via the existing
// ShareFile-bridge cron's Deploy settings — no configurable timeout field),
// well above the real ~10-minute ingestion time, so a dedicated cron here is
// safe.
//
// runScheduledLogiFormsCheck (not checkAndIngestLogiForms directly) is what
// this calls, on purpose: it's the function that applies the real ~60-min
// throttle (isProcessDue) and the once-daily forced-recheck safety net, and
// also runs the 48h old-collection cleanup — all of that would be lost if
// this script called checkAndIngestLogiForms directly. Scheduling this cron
// every 15 minutes (rather than every 60) just means isProcessDue no-ops on
// most ticks; it costs nothing beyond a cheap DB read to check "is it due".
(async () => {
  let failed = false;
  try {
    await connectDB();

    const { checkAndIngestLogiForms, runScheduledLogiFormsCheck, dropExpiredOldLogiFormsCollections } = require('./services/logiFormsIngestService');

    let result;
    if (isForced()) {
      console.log('[RUN-LOGIFORMS-INGEST] --force/FORCE_RUN set - bypassing the hourly-interval throttle.');
      result = await checkAndIngestLogiForms({ force: true });
      const dropResult = await dropExpiredOldLogiFormsCollections();
      result = { ...result, droppedOldCollections: dropResult.dropped };
    } else {
      result = await runScheduledLogiFormsCheck();
    }

    if (result?.skipped) {
      console.log(`[RUN-LOGIFORMS-INGEST] Skipped - ${result.reason}${result.minutesRemaining ? ` (~${result.minutesRemaining} min remaining)` : ''}.`);
    } else if (result?.success === false) {
      console.error(`[RUN-LOGIFORMS-INGEST] Run failed: ${result.error}`);
      failed = true;
    } else {
      console.log('[RUN-LOGIFORMS-INGEST] Completed successfully.', JSON.stringify(result));
    }
  } catch (error) {
    failed = true;
    console.error('[RUN-LOGIFORMS-INGEST] Unexpected error:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('[RUN-LOGIFORMS-INGEST] Connection closed, exiting.');
  }
  process.exit(failed ? 1 : 0);
})();
