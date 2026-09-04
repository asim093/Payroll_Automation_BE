require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ApplicantReminder = require('../models/ApplicantReminder');

const run = async () => {
  let failed = false;
  try {
    await connectDB();
    await ApplicantReminder.createIndexes();
    const indexes = await ApplicantReminder.collection.indexes();
    console.log('[ENSURE] ApplicantReminder indexes:');
    for (const index of indexes) {
      console.log(`  ${index.name}  ${JSON.stringify(index.key)}${index.unique ? '  UNIQUE' : ''}`);
    }
    console.log('[ENSURE] Done.');
  } catch (error) {
    failed = true;
    console.error('[ENSURE] ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

if (require.main === module) {
  run();
}

module.exports = { run };
