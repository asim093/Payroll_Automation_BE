require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');

const GENUINE_ATTACHMENT_REVIEW_QUEUE_ID = '6a8f15c243bac44271046fe4';

const HIGH_RISK_REVIEW_QUEUE_IDS = [
  '6a8fa96c26a9c4815bf62251',
  '6a8fa96e26a9c4815bf62253',
  '6a8fa97026a9c4815bf62255',
  '6a8fa97226a9c4815bf62257',
  '6a8fa97526a9c4815bf62259',
  '6a8fa97726a9c4815bf6225b',
  '6a8fa97926a9c4815bf6225d',
  '6a8fa97b26a9c4815bf6225f',
  '6a8fa97d26a9c4815bf62261',
  '6a8fa97f26a9c4815bf62263',
  '6a8fa98126a9c4815bf62265',
  '6a8fa98326a9c4815bf62267',
  '6a8fa98526a9c4815bf62269',
  '6a8fabc086a28eb502f01fd2',
  '6a8fabc286a28eb502f01fd4',
  '6a8fabc486a28eb502f01fd6',
  '6a90881058b8dfc9a534d9a9',
  '6a90881258b8dfc9a534d9ab',
  '6a90881458b8dfc9a534d9ad',
  '6a90881658b8dfc9a534d9af',
  '6a90894e349ca95acad05558',
  '6a908b9b0cb112be06193682',
  '6a908b9f0cb112be06193686',
  '6a908ba10cb112be06193688',
  '6a908df168b4a890bf3f9794',
  '6a908df368b4a890bf3f9796',
  '6a9094f40f72be015b632a2c',
  '6a90fc149008d82cad3cf4a5',
  '6a90fc169008d82cad3cf4a7',
  '6a90fc189008d82cad3cf4a9',
  '6a90fc1a9008d82cad3cf4ab',
  '6a90fc1c9008d82cad3cf4ad',
  '6a90fc1e9008d82cad3cf4af',
  '6a90fc209008d82cad3cf4b1',
  '6a90fc229008d82cad3cf4b3',
  '6a90fc249008d82cad3cf4b5',
  '6a90fc269008d82cad3cf4b7',
  '6a90fc289008d82cad3cf4b9',
  '6a90fc2a9008d82cad3cf4bb',
  '6a90fc2c9008d82cad3cf4bd',
  '6a90fc2e9008d82cad3cf4bf',
  '6a90fc309008d82cad3cf4c1',
  '6a90fc329008d82cad3cf4c3',
  '6a917d0476936457d8e26a77',
];

const run = async () => {
  try {
    await connectDB();

    console.log(`High-risk ID list has ${HIGH_RISK_REVIEW_QUEUE_IDS.length} entries (expected: 44).`);
    if (HIGH_RISK_REVIEW_QUEUE_IDS.length !== 44) {
      throw new Error('SAFETY ABORT: high-risk ID list does not have exactly 44 entries. Nothing was changed.');
    }

    const allEmailEntries = await ReviewQueue.find({ type: 'email' }).sort({ createdAt: 1 });
    console.log(`Total ReviewQueue entries of type "email" right now: ${allEmailEntries.length} (originally assessed: 109; any extra are new arrivals since the assessment and will be left untouched).`);

    const originalSet = allEmailEntries.slice(0, 109);
    const newArrivals = allEmailEntries.slice(109);
    if (newArrivals.length > 0) {
      console.log(`${newArrivals.length} new entr${newArrivals.length === 1 ? 'y has' : 'ies have'} arrived since the assessment - these will NOT be touched by this migration.`);
    }

    const allIds = new Set(originalSet.map((entry) => String(entry._id)));
    const missing = HIGH_RISK_REVIEW_QUEUE_IDS.filter((id) => !allIds.has(id));
    if (missing.length > 0) {
      throw new Error(`SAFETY ABORT: ${missing.length} high-risk ID(s) do not match any entry in the original 109: ${missing.join(', ')}. Nothing was changed.`);
    }
    if (!allIds.has(GENUINE_ATTACHMENT_REVIEW_QUEUE_ID)) {
      throw new Error(`SAFETY ABORT: the known genuine-attachment ReviewQueue ID ${GENUINE_ATTACHMENT_REVIEW_QUEUE_ID} was not found in the original 109. Nothing was changed.`);
    }

    const highRiskSet = new Set(HIGH_RISK_REVIEW_QUEUE_IDS);
    const lowRiskEntries = originalSet.filter(
      (entry) => !highRiskSet.has(String(entry._id)) && String(entry._id) !== GENUINE_ATTACHMENT_REVIEW_QUEUE_ID
    );
    console.log(`Low-risk (to archive) entries: ${lowRiskEntries.length} (expected: 64 = 109 - 44 - 1 genuine-attachment).`);
    if (lowRiskEntries.length !== 64) {
      throw new Error(`SAFETY ABORT: expected exactly 64 low-risk entries, computed ${lowRiskEntries.length}. Nothing was changed.`);
    }

    console.log('\n=== STEP 1: Updating 44 high-risk entries to reason "possible_missed_attachment" ===');
    const step1Result = await ReviewQueue.updateMany(
      { _id: { $in: HIGH_RISK_REVIEW_QUEUE_IDS } },
      { $set: { reason: 'possible_missed_attachment' } }
    );
    console.log(`Matched: ${step1Result.matchedCount}, Modified: ${step1Result.modifiedCount}`);

    console.log('\n=== STEP 2: Archiving low-risk entries (archivedReason: "no_attachment") ===');
    const lowRiskIds = lowRiskEntries.map((entry) => entry._id);
    const step2Result = await ReviewQueue.updateMany(
      { _id: { $in: lowRiskIds } },
      { $set: { archivedReason: 'no_attachment' } }
    );
    console.log(`Matched: ${step2Result.matchedCount}, Modified: ${step2Result.modifiedCount}`);

    console.log('\n=== STEP 3: Verification ===');
    const visibleNow = await ReviewQueue.countDocuments({ type: 'email', resolvedClientId: null, archivedReason: null });
    const archivedNow = await ReviewQueue.countDocuments({ type: 'email', archivedReason: 'no_attachment' });
    const totalNow = await ReviewQueue.countDocuments({ type: 'email' });
    const possibleMissedNow = await ReviewQueue.countDocuments({ type: 'email', reason: 'possible_missed_attachment' });

    console.log(`Visible in Review Queue now (unresolved, not archived): ${visibleNow} (expected: 45 from this migration, plus ${newArrivals.length} untouched new arrival(s) = ${45 + newArrivals.length})`);
    console.log(`Archived (archivedReason: no_attachment): ${archivedNow} (expected: 64)`);
    console.log(`With reason "possible_missed_attachment": ${possibleMissedNow} (expected: 44)`);
    console.log(`Total email-type ReviewQueue entries (unchanged count, no deletions): ${totalNow} (expected: ${109 + newArrivals.length})`);
  } catch (error) {
    console.error('\nMIGRATION STOPPED:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
