const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');
const MatchingRule = require('../../models/MatchingRule');
const { syncLegacyRulesForClient } = require('../../services/matchingRuleSyncService');


(async () => {
  try {
    await connectDB();

    const inactiveClients = await Client.find({ status: 'inactive' });
    console.log(`Found ${inactiveClients.length} inactive clients.\n`);

    const eligible = [];
    const excluded = [];

    for (const client of inactiveClients) {
      const existingCount = await MatchingRule.countDocuments({ clientId: client._id });
      if (existingCount === 0) {
        eligible.push(client);
      } else {
        excluded.push({ name: client.name, existingCount });
      }
    }

    console.log(`Eligible (zero existing MatchingRule docs): ${eligible.length}`);
    console.log(`Excluded (already have MatchingRule docs — left untouched): ${excluded.length}`);
    if (excluded.length) {
      excluded.forEach((e) => console.log(`  - ${e.name}: ${e.existingCount} existing MatchingRule doc(s)`));
    }

    console.log('\n--- Processing eligible clients ---');
    let totalCreated = 0;
    const processed = [];

    for (const client of eligible) {
      const beforeStatus = client.status;
      await syncLegacyRulesForClient(client);
      const afterCount = await MatchingRule.countDocuments({ clientId: client._id });
      totalCreated += afterCount;
      processed.push({ id: client._id, name: client.name, rulesCreated: afterCount });

      // Confirm status was never touched by the sync call.
      const freshClient = await Client.findById(client._id).select('status').lean();
      if (freshClient.status !== beforeStatus) {
        console.error(`  !! STATUS CHANGED for "${client.name}": was "${beforeStatus}", now "${freshClient.status}"`);
      }

      console.log(`${client.name} | MatchingRule docs created: ${afterCount}`);
    }


    const stillInactiveCount = await Client.countDocuments({
      _id: { $in: processed.map((p) => p.id) },
      status: 'inactive',
    });
    console.log(`Status still 'inactive' for: ${stillInactiveCount} of ${processed.length} processed clients.`);

    // 5 random samples.
    const sampleSize = Math.min(5, processed.length);
    const shuffled = [...processed].sort(() => Math.random() - 0.5);
    const samples = shuffled.slice(0, sampleSize);

    console.log('\n--- 5 RANDOM SAMPLES ---');
    for (const sample of samples) {
      const rules = await MatchingRule.find({ clientId: sample.id }).lean();
      console.log(`\n${sample.name}:`);
      rules.forEach((r) => console.log(`  - type: ${r.type}, value: "${r.value}", active: ${r.active}, source: ${r.source}`));
    }
  } catch (error) {
    console.error('FATAL ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
})();
