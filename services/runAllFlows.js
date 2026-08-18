/**
 * Shared "run all three flows" orchestrator - used by BOTH the cron
 * scheduler (scheduler.js, every 5 min) and the on-demand trigger endpoint
 * (routes/triggerRoutes.js, GET /api/trigger-scan). Keeping this in one
 * place guarantees both callers get the exact same behaviour, in
 * particular: each flow (delegated inbox, app-only inbox, ShareFile scan)
 * has its OWN try/catch, so one flow hanging or failing never blocks or
 * skips the other two.
 *
 * After all three flows finish (success or failure), the result is
 * persisted to the single SystemStatus document so it can be checked later
 * via GET /api/last-run-status without needing to wait on the request that
 * triggered the run.
 */
const { processInboxDelegated } = require('../processInboxDelegated');
const { processInbox } = require('../processInbox');
const { processShareFileScan } = require('../processShareFileScan');
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

const runAllFlows = async () => {
  console.log(`\n[RUN-ALL-FLOWS] Job started at ${new Date().toISOString()}`);

  // Delta-fetch watermark for email-scanning (see
  // graphService.getRecentEmails) — read once here and shared by BOTH email
  // flows (delegated + app-only), since they poll the same underlying
  // timeline and there's no reason to track two separate watermarks.
  // Replaces the old isRead:false filter, which permanently missed any
  // email a user opened in Outlook before our scan got to it.
  const existingStatus = await SystemStatus.findOne();
  const lastEmailScanAt = existingStatus?.lastEmailScanAt;
  const sinceTimestamp = lastEmailScanAt || new Date(Date.now() - 60 * 60 * 1000);
  console.log(
    `[RUN-ALL-FLOWS] Email scan window starts at ${sinceTimestamp.toISOString()}` +
      (lastEmailScanAt ? '' : ' (no previous scan recorded - defaulting to last 1 hour)')
  );

  // Captured BEFORE running the flows (not after they finish) so the new
  // watermark stays conservative — anything that arrives while THIS scan is
  // still in progress gets picked up again next cycle instead of possibly
  // being skipped by a watermark that moved past it.
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
};

module.exports = { runAllFlows, runDelegatedFlow, runAppOnlyFlow, runShareFileScanFlow };
