require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getRecentEmails, getEmailAttachments } = require('./services/graphService');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');
const { processEmail } = require('./services/emailProcessor');
const { startPhase, startItem, completeItem } = require('./services/scanActivityService');
const EmailLog = require('./models/EmailLog');


const processInboxDelegated = async (sinceTimestamp) => {
  const mailboxEmail = process.env.DELEGATED_MAILBOX_EMAIL;
  if (!mailboxEmail) {
    throw new Error('DELEGATED_MAILBOX_EMAIL .env mein set nahi hai.');
  }

  const accessToken = await getAccessTokenFromRefreshToken();

  console.log(
    `Fetching emails for: ${mailboxEmail} (delegated, "me") received since ${
      sinceTimestamp ? new Date(sinceTimestamp).toISOString() : '(last 1 hour, default)'
    }...`
  );

  const inboxMessages = await getRecentEmails(undefined, accessToken, undefined, sinceTimestamp);
  const junkMessages = await getRecentEmails(undefined, accessToken, 'JunkEmail', sinceTimestamp);

  const messages = [
    ...inboxMessages.map((message) => ({ ...message, _sourceFolder: 'Inbox' })),
    ...junkMessages.map((message) => ({ ...message, _sourceFolder: 'Junk' })),
  ];

  console.log(`Fetched: ${inboxMessages.length} from Inbox, ${junkMessages.length} from Junk.`);
  if (messages.length === 0) {
    console.log('No new emails found since last scan.');
  }

  let matchedCount = 0;
  let needsReviewCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  await startPhase('Delegated Inbox Scan (Inbox + Junk)', messages.length);

  for (const message of messages) {
    console.log(`\n[${message._sourceFolder}] "${message.subject || '(no subject)'}"`);
    await startItem(message.subject || '(no subject)');

    try {
    
      const alreadyLogged = await EmailLog.exists({ messageId: message.id });

      let attachments = [];
      if (message.hasAttachments) {
        const graphAttachments = await getEmailAttachments(undefined, message.id, accessToken);
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

      const result = await processEmail(emailData, accessToken, true);

      if (alreadyLogged) {
        duplicateCount++;
      } else if (result.status === 'processed') {
        matchedCount++;
      } else if (result.status === 'needs_review') {
        needsReviewCount++;
      }
    } catch (error) {
      errorCount++;
      console.error(`  ERROR processing message from ${message._sourceFolder}: ${error.message}`);
    }

    await completeItem();
  }

  const summary = {
    totalFetched: messages.length,
    fromInbox: inboxMessages.length,
    fromJunk: junkMessages.length,
    matched: matchedCount,
    needsReview: needsReviewCount,
    duplicates: duplicateCount,
    errors: errorCount,
  };

  console.log('\n--- Inbox processing summary (delegated) ---');
  console.log(`Total messages fetched: ${summary.totalFetched} (Inbox: ${summary.fromInbox}, Junk: ${summary.fromJunk})`);
  console.log(`Matched to a client (processed): ${summary.matched}`);
  console.log(`Sent to review queue (no match): ${summary.needsReview}`);
  console.log(`Skipped as duplicates: ${summary.duplicates}`);
  console.log(`Errored (skipped): ${summary.errors}`);

  return summary;
};

if (require.main === module) {
  (async () => {
    let failed = false;
    try {
      await connectDB();
      await processInboxDelegated();
    } catch (error) {
      failed = true;
      console.error('Error processing inbox (delegated):', error.message);
    } finally {
      await mongoose.connection.close();
      console.log('\nConnection closed.');
    }
    if (failed) process.exit(1);
  })();
}

module.exports = { processInboxDelegated };
