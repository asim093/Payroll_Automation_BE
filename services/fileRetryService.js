
const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const { saveToDestinations } = require('./emailProcessor');
const { downloadFileContentById } = require('./sharefileService');
const { getEmailAttachments } = require('./graphService');
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
const { withResilientMessageId } = require('./emailIdResolver');

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

   
    const emailLog = await EmailLog.findOne({ messageId: fileLog.sourceMessageId });
    if (!emailLog) {
      throw new Error('The source email for this file could not be found in our records - cannot retry automatically');
    }
    const isDelegated = emailLog.authMode === 'delegated';
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

    const attachments = await withResilientMessageId(emailLog, mailboxEmail, accessToken, (currentId) =>
      getEmailAttachments(mailboxEmail, currentId, accessToken)
    );
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
