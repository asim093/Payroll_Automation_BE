
require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { processInboxDelegated } = require('./processInboxDelegated');
const { processInbox } = require('./processInbox');
const { processShareFileScan } = require('./processShareFileScan');

const CRON_SCHEDULE = '*/5 * * * *'; // every 5 minutes

const runDelegatedFlow = async () => {
  const hasDelegatedConfig =
    process.env.DELEGATED_REFRESH_TOKEN &&
    process.env.DELEGATED_CLIENT_ID &&
    process.env.DELEGATED_MAILBOX_EMAIL;

  if (!hasDelegatedConfig) {
    console.log(
      '[SCHEDULER] Delegated flow: DELEGATED_REFRESH_TOKEN/DELEGATED_CLIENT_ID/DELEGATED_MAILBOX_EMAIL not set - skipping.'
    );
    return;
  }

  try {
    console.log('[SCHEDULER] Running delegated flow (idin333)...');
    await processInboxDelegated();
  } catch (error) {
    console.error('[SCHEDULER] Delegated flow ERROR:', error.message);
  }
};

const runAppOnlyFlow = async () => {
  if (!process.env.TEST_MAILBOX_EMAIL) {
    console.log('[SCHEDULER] App-only flow: TEST_MAILBOX_EMAIL not set - skipping.');
    return;
  }

  try {
    console.log('[SCHEDULER] Running app-only flow...');
    await processInbox();
  } catch (error) {
    console.error('[SCHEDULER] App-only flow ERROR:', error.message);
  }
};

const runShareFileScanFlow = async () => {
  try {
    console.log('[SCHEDULER] Running ShareFile scan...');
    await processShareFileScan();
  } catch (error) {
    console.error('[SCHEDULER] ShareFile scan ERROR:', error.message);
  }
};

const runJob = async () => {
  console.log(`\n[SCHEDULER] Job started at ${new Date().toISOString()}`);


  await runDelegatedFlow();
  await runAppOnlyFlow();
  await runShareFileScanFlow();

  console.log(`[SCHEDULER] Job ended at ${new Date().toISOString()}`);
};

const start = async () => {
  await connectDB();

  console.log(`[SCHEDULER] Started. Will run every 5 minutes (cron: "${CRON_SCHEDULE}").`);
  console.log('[SCHEDULER] Press Ctrl+C to stop.');

  
  await runJob();
  cron.schedule(CRON_SCHEDULE, runJob);
};

start();

process.on('SIGINT', async () => {
  console.log('\n[SCHEDULER] Stopping (SIGINT received)...');
  await mongoose.connection.close();
  process.exit(0);
});
