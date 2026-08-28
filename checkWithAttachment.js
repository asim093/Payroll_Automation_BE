require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');
const EmailLog = require('./models/EmailLog');

const run = async () => {
  await connectDB();
  const emailEntries = await ReviewQueue.find({ type: 'email' }).lean();
  const emailIds = emailEntries.map((entry) => entry.referenceId);
  const emailLogs = await EmailLog.find({ _id: { $in: emailIds } }).lean();
  const emailLogMap = new Map(emailLogs.map((log) => [String(log._id), log]));

  console.log('ReviewQueue "email" entries WITH at least 1 attachment:');
  for (const entry of emailEntries) {
    const log = emailLogMap.get(String(entry.referenceId));
    if (log && log.attachments && log.attachments.length > 0) {
      console.log(`ReviewQueue ID: ${entry._id}`);
      console.log(`EmailLog ID: ${log._id}`);
      console.log(`Subject: "${log.subject}"`);
      console.log(`Sender: ${log.sender}`);
      console.log(`Received: ${log.receivedAt}`);
      console.log(`Attachments:`, JSON.stringify(log.attachments));
      console.log('---');
    }
  }
  await mongoose.connection.close();
};
run();
