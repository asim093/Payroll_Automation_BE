/**
 * Re-attempts saving a permanently-failed FileLog (status:'failed', both
 * Dropbox AND local storage failed at the time it was first processed).
 *
 * The tricky part: the attachment's actual BYTES were never persisted
 * anywhere once the original save failed (see emailProcessor.js's
 * saveToDestinations() — contentBuffer only ever lives in memory for the
 * duration of one processing pass). So a retry can't just "try the upload
 * again" - it has to re-fetch the original content from wherever it
 * actually still lives:
 *   - source 'sharefile': re-download by the stored sourceFileId.
 *   - source 'outlook': re-fetch the source email's attachments via Graph
 *     (using sourceMessageId) and match by original filename.
 *
 * Updates the SAME FileLog document in place (via saveToDestinations's
 * updateFileLogId option) rather than creating a second entry, so retrying
 * doesn't leave a duplicate row in the file history.
 */
const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const { saveToDestinations } = require('./emailProcessor');
const { downloadFileContentById } = require('./sharefileService');
const { getEmailAttachments } = require('./graphService');
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');

const retryFailedFile = async (fileLog) => {
  if (fileLog.status !== 'failed') {
    throw new Error('Only failed files can be retried');
  }

  const client = await Client.findById(fileLog.clientId);
  if (!client) {
    throw new Error('The client this file belonged to no longer exists');
  }

  let contentBuffer;

  if (fileLog.source === 'sharefile') {
    if (!fileLog.sourceFileId) {
      throw new Error('No ShareFile source reference on file - cannot retry automatically');
    }
    contentBuffer = await downloadFileContentById(fileLog.sourceFileId);
  } else if (fileLog.source === 'outlook') {
    if (!fileLog.sourceMessageId) {
      throw new Error('No source-email reference on file - cannot retry automatically (this file predates that being tracked)');
    }

    // The delegated-vs-app-only choice has to match however the ORIGINAL
    // email was fetched, so we're re-authenticating against the same
    // mailbox the attachment actually lives in - see EmailLog.authMode.
    const emailLog = await EmailLog.findOne({ messageId: fileLog.sourceMessageId });
    const isDelegated = emailLog?.authMode === 'delegated';
    let accessToken;
    let mailboxEmail;
    if (isDelegated) {
      accessToken = await getAccessTokenFromRefreshToken();
    } else {
      mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
      if (!mailboxEmail) {
        throw new Error('TEST_MAILBOX_EMAIL not configured - cannot re-fetch this attachment');
      }
    }

    const attachments = await getEmailAttachments(mailboxEmail, fileLog.sourceMessageId, accessToken);
    const match = (attachments || []).find((attachment) => attachment.name === fileLog.originalName && attachment.contentBytes);
    if (!match) {
      throw new Error('Original attachment is no longer available on the source email');
    }
    contentBuffer = Buffer.from(match.contentBytes, 'base64');
  } else {
    throw new Error(`Unknown source "${fileLog.source}" - cannot retry`);
  }

  if (!contentBuffer || contentBuffer.length === 0) {
    throw new Error('Re-fetched attachment was empty');
  }

  return saveToDestinations(client, fileLog.originalName, contentBuffer, fileLog.source, {
    sourceMessageId: fileLog.sourceMessageId,
    sourceFileId: fileLog.sourceFileId,
    updateFileLogId: fileLog._id,
  });
};

module.exports = { retryFailedFile };
