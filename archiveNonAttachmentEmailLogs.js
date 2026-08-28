require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const EmailLog = require('./models/EmailLog');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  try {
    await connectDB();

    console.log('=== Locating the 64 confirmed-safe (archivedReason: no_attachment) ReviewQueue entries ===');
    const archivedReviewQueueEntries = await ReviewQueue.find({ type: 'email', archivedReason: 'no_attachment' });
    console.log(`Found: ${archivedReviewQueueEntries.length} (expected: 64).`);
    if (archivedReviewQueueEntries.length !== 64) {
      throw new Error(`SAFETY ABORT: expected exactly 64 archived ReviewQueue entries, found ${archivedReviewQueueEntries.length}. Nothing was changed.`);
    }

    console.log('\n=== Locating the 44 high-risk (reason: possible_missed_attachment) ReviewQueue entries - to confirm they will NOT be touched ===');
    const highRiskReviewQueueEntries = await ReviewQueue.find({ type: 'email', reason: 'possible_missed_attachment' });
    console.log(`Found: ${highRiskReviewQueueEntries.length} (expected: 44).`);
    if (highRiskReviewQueueEntries.length !== 44) {
      throw new Error(`SAFETY ABORT: expected exactly 44 high-risk ReviewQueue entries, found ${highRiskReviewQueueEntries.length}. Nothing was changed.`);
    }
    const highRiskEmailLogIds = new Set(highRiskReviewQueueEntries.map((entry) => String(entry.referenceId)));

    const archivedEmailLogIds = archivedReviewQueueEntries.map((entry) => entry.referenceId);
    const overlap = archivedEmailLogIds.filter((id) => highRiskEmailLogIds.has(String(id)));
    if (overlap.length > 0) {
      throw new Error(`SAFETY ABORT: ${overlap.length} EmailLog id(s) appear in BOTH the archive-list and the high-risk list - this should never happen. Nothing was changed.`);
    }
    console.log('Confirmed: no overlap between the 64 to-archive EmailLogs and the 44 high-risk EmailLogs.');

    console.log('\n=== Checking for EmailLog records already marked status: "no_attachment_skipped" (from the new safety-net, going forward) ===');
    const skippedEmailLogs = await EmailLog.find({ status: 'no_attachment_skipped' });
    console.log(`Found: ${skippedEmailLogs.length}.`);
    const skippedEmailLogIds = skippedEmailLogs.map((log) => log._id);

    const allTargetIds = [...archivedEmailLogIds, ...skippedEmailLogIds];
    const uniqueTargetIds = [...new Set(allTargetIds.map((id) => String(id)))];
    console.log(`\nTotal unique EmailLog records to archive: ${uniqueTargetIds.length} (expected: 64, unless some no_attachment_skipped entries overlap or add to that).`);

    console.log('\n=== STEP 2: Setting archived: true ===');
    const updateResult = await EmailLog.updateMany(
      { _id: { $in: uniqueTargetIds } },
      { $set: { archived: true } }
    );
    console.log(`Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}`);

    console.log('\n=== STEP 4: Verification ===');
    const archivedCount = await EmailLog.countDocuments({ archived: true });
    const totalEmailLogCount = await EmailLog.countDocuments({});
    console.log(`Total EmailLog records archived: true -> ${archivedCount}`);
    console.log(`Total EmailLog records overall (unchanged count, no deletions): ${totalEmailLogCount}`);

    console.log('\nSpot-check: the 44 high-risk EmailLogs still have archived: false/undefined? (must be untouched)');
    const highRiskStillClean = await EmailLog.find({ _id: { $in: [...highRiskEmailLogIds] } }).select('subject archived status');
    const wronglyArchived = highRiskStillClean.filter((log) => log.archived === true);
    console.log(`High-risk EmailLogs incorrectly archived: ${wronglyArchived.length} (must be 0).`);
    if (wronglyArchived.length > 0) {
      console.error('CRITICAL: some high-risk entries got archived! Details:', wronglyArchived);
    }
  } catch (error) {
    console.error('\nMIGRATION STOPPED:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
