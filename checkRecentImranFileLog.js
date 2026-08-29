require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const FileLog = require('./models/FileLog');
const Client = require('./models/Client');

const run = async () => {
  await connectDB();
  const client = await Client.findOne({ name: /imran/i });
  const logs = await FileLog.find({ clientId: client._id }).sort({ createdAt: -1 }).limit(5);
  logs.forEach((log) => {
    console.log(`${log.createdAt.toISOString()} | ${log.fileName} | dest: ${log.destinationPath} | status: ${log.status} | isDemoData: ${log.isDemoData}`);
  });
  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
