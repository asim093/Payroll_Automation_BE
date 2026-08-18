require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getRecentEmails, getEmailAttachments } = require('./services/graphService');
const { processEmail } = require('./services/emailProcessor');
const EmailLog = require('./models/EmailLog');


// @param {Date|string} [sinceTimestamp] - only messages received on/after
//   this time are fetched (delta-fetch watermark - see runAllFlows.js).
//   Omit to fall back to the last 1 hour (used by manual/standalone runs,
//   e.g. `node processInbox.js` directly).
const processInbox = async (sinceTimestamp) => {
  const mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
  if (!mailboxEmail) {
    throw new Error(
      'TEST_MAILBOX_EMAIL .env mein set nahi hai. Pehle license/mailbox setup complete karein.'
    );
  }

  console.log(
    `Fetching emails from mailbox: ${mailboxEmail} received since ${
      sinceTimestamp ? new Date(sinceTimestamp).toISOString() : '(last 1 hour, default)'
    }...`
  );
  const messages = await getRecentEmails(mailboxEmail, undefined, undefined, sinceTimestamp);
  console.log(`Fetched ${messages.length} message(s).`);

  let matchedCount = 0;
  let needsReviewCount = 0;
  let duplicateCount = 0;

  for (const message of messages) {
    const alreadyLogged = await EmailLog.exists({ messageId: message.id });

    let attachments = [];
    if (message.hasAttachments) {
      const graphAttachments = await getEmailAttachments(mailboxEmail, message.id);
      attachments = (graphAttachments || [])
        .filter((attachment) => attachment.contentBytes)
        .map((attachment) => ({
          name: attachment.name,
          contentBase64: attachment.contentBytes,
        }));
    }

    const emailData = {
      messageId: message.id,
      sender:
        message.from?.emailAddress?.address ||
        message.sender?.emailAddress?.address ||
        '',
      subject: message.subject || '',
      receivedDateTime: message.receivedDateTime,
      attachments,
    };

    const result = await processEmail(emailData);

    if (alreadyLogged) {
      duplicateCount++;
    } else if (result.status === 'processed') {
      matchedCount++;
    } else if (result.status === 'needs_review') {
      needsReviewCount++;
    }
  }

  const summary = {
    totalFetched: messages.length,
    matched: matchedCount,
    needsReview: needsReviewCount,
    duplicates: duplicateCount,
  };

  console.log('\n--- Inbox processing summary ---');
  console.log(`Total messages fetched: ${summary.totalFetched}`);
  console.log(`Matched to a client (processed): ${summary.matched}`);
  console.log(`Sent to review queue (no match): ${summary.needsReview}`);
  console.log(`Skipped as duplicates: ${summary.duplicates}`);

  return summary;
};

if (require.main === module) {
  (async () => {
    let failed = false;
    try {
      await connectDB();
      await processInbox();
    } catch (error) {
      failed = true;
      console.error('Error processing inbox:', error.message);
    } finally {
      await mongoose.connection.close();
      console.log('\nConnection closed.');
    }
    if (failed) process.exit(1);
  })();
}

module.exports = { processInbox };
