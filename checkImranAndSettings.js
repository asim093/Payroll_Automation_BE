require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const { getSettings } = require('./services/settingsService');

const run = async () => {
  await connectDB();
  const settings = await getSettings();
  console.log('dropboxRootPath:', settings.dropboxRootPath);

  const client = await Client.findOne({ name: /imran/i });
  if (!client) {
    console.log('No client named Imran found.');
  } else {
    console.log('Client:', client.name, '| dropboxPath:', client.dropboxPath, '| dropboxPathIsAbsolute:', client.dropboxPathIsAbsolute, '| status:', client.status);
  }

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
