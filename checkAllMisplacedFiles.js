require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const FileLog = require('./models/FileLog');

const run = async () => {
  await connectDB();
  const logs = await FileLog.find({
    destinationPath: /^\/WOTC\//,
    status: 'moved',
    createdAt: { $gte: new Date('2026-08-29T00:00:00Z') },
  }).sort({ createdAt: -1 });
  console.log(`FileLog entries with destinationPath starting "/WOTC/" today: ${logs.length}`);
  logs.forEach((log) => console.log(`${log.createdAt.toISOString()} | ${log.destinationPath}`));
  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
