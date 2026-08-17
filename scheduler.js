
require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { runAllFlows } = require('./services/runAllFlows');

const CRON_SCHEDULE = '*/5 * * * *'; // every 5 minutes

// The actual per-flow (delegated inbox / app-only inbox / ShareFile scan)
// try/catch logic lives in services/runAllFlows.js - shared with the
// on-demand GET /api/trigger-scan endpoint so both callers behave
// identically and both leave a SystemStatus record behind.
const runJob = async () => {
  await runAllFlows();
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
