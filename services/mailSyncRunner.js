const SystemStatus = require('../models/SystemStatus');
const { processInboxDelegated } = require('../processInboxDelegated');
const { processInbox } = require('../processInbox');
const { runGuardedProcess } = require('./processRunner');

const PROCESS_KEY = 'mailSync';

const hasDelegatedConfig = () =>
  Boolean(
    process.env.DELEGATED_REFRESH_TOKEN && process.env.DELEGATED_CLIENT_ID && process.env.DELEGATED_MAILBOX_EMAIL
  );

const runDelegatedFlow = async (sinceTimestamp) => {
  if (!hasDelegatedConfig()) {
    console.log('[MAIL-SYNC] Delegated flow: DELEGATED_REFRESH_TOKEN/DELEGATED_CLIENT_ID/DELEGATED_MAILBOX_EMAIL not set - skipping.');
    return { success: true, skipped: true, message: 'Not configured - skipped' };
  }

  try {
    console.log('[MAIL-SYNC] Running delegated flow (idin333)...');
    const summary = await processInboxDelegated(sinceTimestamp);
    return { success: true, summary };
  } catch (error) {
    console.error('[MAIL-SYNC] Delegated flow ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

const runAppOnlyFlow = async (sinceTimestamp) => {
  if (!process.env.TEST_MAILBOX_EMAIL) {
    console.log('[MAIL-SYNC] App-only flow: TEST_MAILBOX_EMAIL not set - skipping.');
    return { success: true, skipped: true, message: 'Not configured - skipped' };
  }

  try {
    console.log('[MAIL-SYNC] Running app-only flow...');
    const summary = await processInbox(sinceTimestamp);
    return { success: true, summary };
  } catch (error) {
    console.error('[MAIL-SYNC] App-only flow ERROR:', error.message);
    return { success: false, error: error.message };
  }
};

const runMailSyncOnce = async () => {
  console.log(`\n[MAIL-SYNC] Run started at ${new Date().toISOString()}`);

  return runGuardedProcess(PROCESS_KEY, async () => {
    const status = await SystemStatus.findOne();
    const lastEmailScanAt = status?.lastEmailScanAt;
    const sinceTimestamp = lastEmailScanAt || new Date(Date.now() - 60 * 60 * 1000);
    console.log(
      `[MAIL-SYNC] Email scan window starts at ${sinceTimestamp.toISOString()}` +
        (lastEmailScanAt ? '' : ' (no previous scan recorded - defaulting to last 1 hour)')
    );

    const scanStartedAt = new Date();

    const delegatedFlow = await runDelegatedFlow(sinceTimestamp);
    const appOnlyFlow = await runAppOnlyFlow(sinceTimestamp);

    console.log(`[MAIL-SYNC] Run ended at ${new Date().toISOString()}`);

    const emailScanSucceeded = delegatedFlow.success && appOnlyFlow.success;
    if (emailScanSucceeded) {
      try {
        await SystemStatus.findOneAndUpdate({}, { lastEmailScanAt: scanStartedAt }, { upsert: true });
      } catch (error) {
        console.error('[MAIL-SYNC] Failed to persist lastEmailScanAt:', error.message);
      }
    }

    return {
      success: delegatedFlow.success && appOnlyFlow.success,
      delegatedFlow,
      appOnlyFlow,
    };
  });
};

module.exports = { runMailSyncOnce };
