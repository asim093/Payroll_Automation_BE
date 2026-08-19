

require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { runAllFlows } = require('./services/runAllFlows');

const CRON_SCHEDULE = '*/5 * * * *'; // every 5 minutes


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
