/**
 * Shared "run all three flows" orchestrator - used by scheduler.js (an
 * in-process node-cron loop, every 5 min - suitable for a continuously-
 * running host) and by runScanOnce.js (a single-shot entry point for
 * Render's native Cron Job service, which spins up a fresh container per
 * schedule instead of staying resident - see that file's own comment).
 * Keeping this in one place guarantees both callers get the exact same
 * behaviour, in particular: each flow (delegated inbox, app-only inbox,
 * ShareFile scan) has its OWN try/catch, so one flow hanging or failing
 * never blocks or skips the other two - and the isEmailScanRunning DB lock
 * (below) protects against either caller's runs overlapping with each
 * other, not just against itself.
 *
 * After all three flows finish (success or failure), the result is
 * persisted to the single SystemStatus document so it can be checked later
 * via GET /api/last-run-status without needing to wait on the request that
 * triggered the run.
 */
const { processInboxDelegated } = require('../processInboxDelegated');
const { processInbox } = require('../processInbox');
const { processShareFileScan } = require('../processShareFileScan');
const { endActivity } = require('./scanActivityService');
const SystemStatus = require('../models/SystemStatus');

const runDelegatedFlow = async (sinceTimestamp) => {
  const hasDelegatedConfig =
    process.env.DELEGATED_REFRESH_TOKEN &&
    process.env.DELEGATED_CLIENT_ID &&
    process.env.DELEGATED_MAILBOX_EMAIL;

  if (!hasDelegatedConfig) {
    console.log(
      '[RUN-ALL-FLOWS] Delegated flow: DELEGATED_REFRESH_TOKEN/DELEGATED_CLIENT_ID/DELEGATED_MAILBOX_EMAIL not set - skipping.'
    );
    return { success: true, skipped: true, message: 'Not configured - skipped' };
  }

  try {
    console.log('[RUN-ALL-FLOWS] Running delegated flow (idin333)...');
    const summary = await processInboxDelegated(sinceTimestamp);
    return { success: true, summary };
  } catch (error) {
    console.error('[RUN-ALL-FLOWS] Delegated flow ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

const runAppOnlyFlow = async (sinceTimestamp) => {
  if (!process.env.TEST_MAILBOX_EMAIL) {
    console.log('[RUN-ALL-FLOWS] App-only flow: TEST_MAILBOX_EMAIL not set - skipping.');
    return { success: true, skipped: true, message: 'Not configured - skipped' };
  }

  try {
    console.log('[RUN-ALL-FLOWS] Running app-only flow...');
    const summary = await processInbox(sinceTimestamp);
    return { success: true, summary };
  } catch (error) {
    console.error('[RUN-ALL-FLOWS] App-only flow ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

const runShareFileScanFlow = async () => {
  try {
    console.log('[RUN-ALL-FLOWS] Running ShareFile scan...');
    const summary = await processShareFileScan();
    return { success: true, summary };
  } catch (error) {
    console.error('[RUN-ALL-FLOWS] ShareFile scan ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

// Cron-overlap guard threshold — a lock older than this is treated as
// abandoned (the run that acquired it almost certainly crashed before
// reaching the finally-block that would have released it) rather than
// blocking every future cycle forever. Picked well above the 5-minute cron
// interval so a merely-slow-but-still-running scan is never mistaken for a
// stale one.
const EMAIL_SCAN_LOCK_STALE_MS = 15 * 60 * 1000; // 15 minutes

const runAllFlows = async () => {
  console.log(`\n[RUN-ALL-FLOWS] Job started at ${new Date().toISOString()}`);

  // --- Overlap guard -----------------------------------------------------
  // Without this, a scan that runs longer than the 5-minute cron interval
  // (plausible under high email volume — see the per-email network-call
  // count in emailProcessor.js) would still be in-flight when the next
  // cron tick fires, and a second concurrent runAllFlows() would start
  // fetching/processing the same emails — a duplicate-Dropbox-upload /
  // duplicate-category-call race that only gets caught at the very end by
  // EmailLog's unique messageId index, after the wasted work already
  // happened.
  //
  // The check-and-acquire is done as ONE atomic findOneAndUpdate, not a
  // separate find-then-set — a live concurrency test (firing two
  // runAllFlows() calls at the exact same instant) proved that a plain
  // "read the flag, then write it" sequence lets both concurrent calls see
  // "unlocked" before either has written anything, so both proceed. Baking
  // the "is it actually free-or-stale" condition into the update's filter
  // makes MongoDB itself the tie-breaker: only one of two racing
  // findOneAndUpdate calls against the same document can match-and-update
  // first, and the loser gets null back — reliably, not just "usually".
  const staleThreshold = new Date(Date.now() - EMAIL_SCAN_LOCK_STALE_MS);

  let lockDoc = await SystemStatus.findOneAndUpdate(
    { $or: [{ isEmailScanRunning: { $ne: true } }, { emailScanStartedAt: { $lt: staleThreshold } }] },
    { isEmailScanRunning: true, emailScanStartedAt: new Date() },
    { returnDocument: 'after' }
    // Deliberately NOT upsert:true here — if the filter doesn't match, it
    // should mean "lock is actively held by someone else", not "create a
    // second SystemStatus document" (which upsert would do and would break
    // the single-document assumption every time the lock is legitimately busy).
  );

  if (!lockDoc) {
    // The filter didn't match. Two possibilities: (a) the lock is actively
    // held and still fresh — the real "skip this cycle" case — or (b) no
    // SystemStatus document exists at all yet (the very first call this
    // app has ever made), which also can't match an $or filter built
    // entirely out of field comparisons. Tell them apart before deciding.
    const existing = await SystemStatus.findOne();

    if (existing) {
      const lockAgeMs = Date.now() - new Date(existing.emailScanStartedAt).getTime();
      console.log(
        `[RUN-ALL-FLOWS] Previous scan still running (started ${Math.round(lockAgeMs / 1000)}s ago) - skipping this cycle.`
      );
      return { skipped: true, reason: 'previous_scan_still_running' };
    }

    // First-ever call, nothing to race against — safe to upsert here.
    lockDoc = await SystemStatus.findOneAndUpdate(
      {},
      { isEmailScanRunning: true, emailScanStartedAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );
  }

  const existingStatus = lockDoc;

  try {
    // Delta-fetch watermark for email-scanning (see
    // graphService.getRecentEmails) — read once here and shared by BOTH
    // email flows (delegated + app-only), since they poll the same
    // underlying timeline and there's no reason to track two separate
    // watermarks. Replaces the old isRead:false filter, which permanently
    // missed any email a user opened in Outlook before our scan got to it.
    const lastEmailScanAt = existingStatus?.lastEmailScanAt;
    const sinceTimestamp = lastEmailScanAt || new Date(Date.now() - 60 * 60 * 1000);
    console.log(
      `[RUN-ALL-FLOWS] Email scan window starts at ${sinceTimestamp.toISOString()}` +
        (lastEmailScanAt ? '' : ' (no previous scan recorded - defaulting to last 1 hour)')
    );

    // Captured BEFORE running the flows (not after they finish) so the new
    // watermark stays conservative — anything that arrives while THIS scan
    // is still in progress gets picked up again next cycle instead of
    // possibly being skipped by a watermark that moved past it.
    const scanStartedAt = new Date();

    // Sequential (not parallel) on purpose - same behaviour as the original
    // scheduler.js - but each still has its own try/catch, so a failure in
    // one does not stop the next from running.
    const delegatedFlow = await runDelegatedFlow(sinceTimestamp);
    const appOnlyFlow = await runAppOnlyFlow(sinceTimestamp);
    const shareFileScan = await runShareFileScanFlow();

    console.log(`[RUN-ALL-FLOWS] Job ended at ${new Date().toISOString()}`);

    const results = { delegatedFlow, appOnlyFlow, shareFileScan };
    const overallSuccess = [delegatedFlow, appOnlyFlow, shareFileScan].every((flow) => flow.success);

    // Only advance the email-scan watermark if BOTH email flows completed
    // without throwing — ShareFile's own success/failure doesn't affect it
    // (unrelated concern). A genuine failure in either email flow leaves
    // lastEmailScanAt untouched, so the next cycle re-covers the same window
    // instead of silently skipping whatever arrived during the failed run.
    // Safe to re-cover: EmailLog's messageId-based duplicate check (see
    // processEmail()) skips anything already processed.
    const emailScanSucceeded = delegatedFlow.success && appOnlyFlow.success;

    try {
      await SystemStatus.findOneAndUpdate(
        {},
        {
          lastRunAt: new Date(),
          lastRunResults: results,
          lastRunSuccess: overallSuccess,
          ...(emailScanSucceeded ? { lastEmailScanAt: scanStartedAt } : {}),
        },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (error) {
      // Don't let a DB write failure here mask the actual run results from
      // whoever called runAllFlows().
      console.error('[RUN-ALL-FLOWS] Failed to persist SystemStatus:', error.message);
    }

    return { results, overallSuccess };
  } finally {
    // ALWAYS release the lock — success or error — so a crash never leaves
    // every future cycle blocked until the 15-minute staleness window
    // passes. This is what makes the stale-lock check above a safety-net
    // rather than the primary release mechanism.
    try {
      await SystemStatus.findOneAndUpdate({}, { isEmailScanRunning: false });
    } catch (error) {
      console.error('[RUN-ALL-FLOWS] Failed to release scan lock:', error.message);
    }

    // Clear the live processing-status panel (see scanActivityService.js)
    // ONCE, after all 3 flows are done — not after each individual flow —
    // so the dashboard doesn't flicker to "idle" between phases. Already
    // internally error-safe (see safeUpdate() there), nothing to catch here.
    await endActivity();
  }
};

module.exports = { runAllFlows, runDelegatedFlow, runAppOnlyFlow, runShareFileScanFlow };
