require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');
const EmailLog = require('./models/EmailLog');

const run = async () => {
  try {
    await connectDB();

    const emailEntries = await ReviewQueue.find({ type: 'email' }).lean();
    console.log(`Total ReviewQueue entries of type "email": ${emailEntries.length}`);

    const emailIds = emailEntries.map((entry) => entry.referenceId);
    const emailLogs = await EmailLog.find({ _id: { $in: emailIds } }).lean();
    const emailLogMap = new Map(emailLogs.map((log) => [String(log._id), log]));

    const noAttachmentOnes = [];
    for (const entry of emailEntries) {
      const log = emailLogMap.get(String(entry.referenceId));
      if (!log) {
        console.log(`  ReviewQueue ${entry._id}: underlying EmailLog ${entry.referenceId} not found (orphaned).`);
        continue;
      }
      if (!log.attachments || log.attachments.length === 0) {
        noAttachmentOnes.push({ reviewQueueId: entry._id, emailLogId: log._id, sender: log.sender, subject: log.subject, receivedAt: log.receivedAt, status: entry.resolvedClientId ? 'already resolved' : 'unresolved' });
      }
    }

    console.log(`\nReviewQueue "email" entries with ZERO attachments on their EmailLog: ${noAttachmentOnes.length}`);
    noAttachmentOnes.forEach((item, index) => {
      console.log(`  ${index + 1}. [${item.status}] "${item.subject || '(no subject)'}" from ${item.sender} (received: ${item.receivedAt}) - ReviewQueue ${item.reviewQueueId}`);
    });

    console.log('\n(Read-only check - nothing was modified or deleted.)');
  } catch (error) {
    console.error('Error running check:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
