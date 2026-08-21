require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');

const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');

const confirm = async (question) => {
  if (SKIP_CONFIRM) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

const run = async () => {
  console.log('\n=== Demo Activity Cleanup ===\n');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const [emailCount, fileCount] = await Promise.all([
    EmailLog.countDocuments({ isDemoData: true }),
    FileLog.countDocuments({ isDemoData: true }),
  ]);

  if (emailCount === 0 && fileCount === 0) {
    console.log('\nNo demo data found (isDemoData: true) - nothing to remove.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\nFound ${emailCount} demo EmailLog entries and ${fileCount} demo FileLog entries.`);

  const proceed = await confirm(
    `Delete all ${emailCount + fileCount} demo entries? Real data is untouched. (y/n) `
  );

  if (!proceed) {
    console.log('\nCancelled - nothing was deleted.');
    await mongoose.disconnect();
    return;
  }

  const [emailResult, fileResult] = await Promise.all([
    EmailLog.deleteMany({ isDemoData: true }),
    FileLog.deleteMany({ isDemoData: true }),
  ]);

  console.log(`\nDeleted ${emailResult.deletedCount} demo EmailLog entries and ${fileResult.deletedCount} demo FileLog entries.\n`);

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('CLEANUP ERROR:', error);
  process.exit(1);
});
