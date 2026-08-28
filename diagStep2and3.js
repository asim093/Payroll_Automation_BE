require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const SystemStatus = require('./models/SystemStatus');
const Client = require('./models/Client');
const { getSettings } = require('./services/settingsService');

const run = async () => {
  await connectDB();

  console.log('=== SystemStatus (current DB value) ===');
  const status = await SystemStatus.findOne();
  console.log(JSON.stringify(status, null, 2));

  console.log('\n=== Settings (shareFileRootPath / dropboxRootPath) ===');
  const settings = await getSettings();
  console.log(JSON.stringify(settings, null, 2));

  console.log('\n=== Sample active clients: shareFilePath / shareFilePathIsAbsolute ===');
  const clients = await Client.find({ status: 'active' }).limit(6).select('name shareFilePath shareFilePathIsAbsolute dropboxPath');
  clients.forEach((c) => {
    console.log(`Client: "${c.name}"`);
    console.log(`  shareFilePath: ${JSON.stringify(c.shareFilePath)}`);
    console.log(`  shareFilePathIsAbsolute: ${c.shareFilePathIsAbsolute}`);
    console.log(`  dropboxPath: ${JSON.stringify(c.dropboxPath)}`);
  });

  await mongoose.connection.close();
};
run();
