require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Client = require('../models/Client');
const { setupClientFolders } = require('../services/clientFolderSetupService');

const run = async () => {
  let failed = false;
  try {
    await connectDB();

    const affectedClients = await Client.find({ folderSetupWarnings: { $exists: true, $ne: [] } });
    console.log(`Found ${affectedClients.length} client(s) with existing folderSetupWarnings.`);

    let resolvedCount = 0;
    let stillWarningCount = 0;

    for (const client of affectedClients) {
      console.log(`\n--- ${client.name} (${client._id}) ---`);
      console.log('Before:', JSON.stringify(client.folderSetupWarnings));

      client.folderSetupWarnings = await setupClientFolders(client);
      await client.save();

      if (client.folderSetupWarnings.length === 0) {
        resolvedCount++;
        console.log('After:  RESOLVED - no warnings remain.');
      } else {
        stillWarningCount++;
        console.log('After: ', JSON.stringify(client.folderSetupWarnings));
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Total clients checked: ${affectedClients.length}`);
    console.log(`Resolved: ${resolvedCount}`);
    console.log(`Still have warnings: ${stillWarningCount}`);
  } catch (error) {
    failed = true;
    console.error('SCRIPT ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
