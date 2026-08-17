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

const runDelegatedFlow = async () => {
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
    const summary = await processInboxDelegated();
    return { success: true, summary };
  } catch (error) {
    console.error('[RUN-ALL-FLOWS] Delegated flow ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

const runAppOnlyFlow = async () => {
  if (!process.env.TEST_MAILBOX_EMAIL) {
    console.log('[RUN-ALL-FLOWS] App-only flow: TEST_MAILBOX_EMAIL not set - skipping.');
    return { success: true, skipped: true, message: 'Not configured - skipped' };
  }

  try {
    console.log('[RUN-ALL-FLOWS] Running app-only flow...');
    const summary = await processInbox();
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

  // Sequential (not parallel) on purpose - same behaviour as the original
  // scheduler.js - but each still has its own try/catch, so a failure in
  // one does not stop the next from running.
  const delegatedFlow = await runDelegatedFlow();
  const appOnlyFlow = await runAppOnlyFlow();
  const shareFileScan = await runShareFileScanFlow();

  console.log(`[RUN-ALL-FLOWS] Job ended at ${new Date().toISOString()}`);

  const results = { delegatedFlow, appOnlyFlow, shareFileScan };
  const overallSuccess = [delegatedFlow, appOnlyFlow, shareFileScan].every((flow) => flow.success);

  try {
    await SystemStatus.findOneAndUpdate(
      {},
      {
        lastRunAt: new Date(),
        lastRunResults: results,
        lastRunSuccess: overallSuccess,
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
