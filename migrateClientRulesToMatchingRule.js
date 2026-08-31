require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const MatchingRule = require('./models/MatchingRule');
const { syncLegacyRulesForClient } = require('./services/matchingRuleSyncService');

const run = async () => {
  try {
    await connectDB();

    const existingRuleCount = await MatchingRule.countDocuments({});
    console.log(`Existing MatchingRule documents before migration: ${existingRuleCount} (expected: 0, first run).`);
    if (existingRuleCount !== 0) {
      throw new Error(
        `SAFETY ABORT: expected MatchingRule collection to be empty before this one-time migration, found ${existingRuleCount} document(s). Nothing was changed. If you intended to re-run this, clear the collection deliberately first.`
      );
    }

    const clients = await Client.find({});
    console.log(`Found ${clients.length} client(s) to migrate.`);

    let totalRulesCreated = 0;
    for (const client of clients) {
      const before = await MatchingRule.countDocuments({ clientId: client._id });
      await syncLegacyRulesForClient(client);
      const after = await MatchingRule.countDocuments({ clientId: client._id });
      const created = after - before;
      totalRulesCreated += created;
      console.log(
        `${client.name} (${client._id}): ${created} rule(s) created (emails: ${client.matchingRules?.emailAddresses?.length || 0}, domains: ${client.matchingRules?.domains?.length || 0}, notificationPattern: ${client.matchingRules?.notificationSenderPattern ? 1 : 0})`
      );
    }

    console.log(`\n=== Verification ===`);
    const finalCount = await MatchingRule.countDocuments({});
    console.log(`Total MatchingRule documents now: ${finalCount} (expected: ${totalRulesCreated})`);
    if (finalCount !== totalRulesCreated) {
      console.error('WARNING: final count does not match expected total - investigate before trusting the new matching path.');
    }

    const byType = await MatchingRule.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]);
    console.log('Breakdown by type:', byType);
  } catch (error) {
    console.error('\nMIGRATION STOPPED:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
