/**
 * ONE-TIME PRE-DEPLOYMENT CLEANUP SCRIPT
 * ------------------------------------------------------------------------
 * Removes development/testing data from the database before going live:
 *   1. Clients whose name starts with "Test" or "Demo" (all the ones we
 *      created for testing throughout development).
 *   2. Every EmailLog, FileLog, and ReviewQueue document — all of it is
 *      test-run output tied to those test clients / mock emails.
 * Real clients (added later, not matching the Test/Demo naming) are left
 * untouched. Run with `node cleanupTestData.js`.
 * ------------------------------------------------------------------------
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const EmailLog = require('./models/EmailLog');
const FileLog = require('./models/FileLog');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  try {
    await connectDB();

    const testClients = await Client.find({ name: { $regex: /^(Test|Demo)/i } }).select('name');
    console.log(`Found ${testClients.length} test/demo client(s):`);
    testClients.forEach((client) => console.log(`  - ${client.name}`));

    const clientResult = await Client.deleteMany({ name: { $regex: /^(Test|Demo)/i } });
    console.log(`\nDeleted ${clientResult.deletedCount} client(s).`);

    const emailResult = await EmailLog.deleteMany({});
    console.log(`Deleted ${emailResult.deletedCount} EmailLog document(s).`);

    const fileResult = await FileLog.deleteMany({});
    console.log(`Deleted ${fileResult.deletedCount} FileLog document(s).`);

    const reviewResult = await ReviewQueue.deleteMany({});
    console.log(`Deleted ${reviewResult.deletedCount} ReviewQueue document(s).`);

    const remainingClients = await Client.find().select('name status');
    console.log(`\nRemaining clients (${remainingClients.length}):`);
    remainingClients.forEach((client) => console.log(`  - ${client.name} (${client.status})`));

    console.log('\nDatabase cleanup complete.');
  } catch (error) {
    console.error('Cleanup failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
  }
};

run();
