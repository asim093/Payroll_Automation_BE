const ReviewQueue = require('../models/ReviewQueue');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const { getEmailAttachments, isInlineImageAttachment } = require('./graphService');
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
const { completeFileProcessing } = require('./emailProcessor');
const { withResilientMessageId } = require('./emailIdResolver');

const claimReviewItem = async (reviewItemId, client) =>
  ReviewQueue.findOneAndUpdate(
    { _id: reviewItemId, resolvedClientId: null },
    { resolvedClientId: client._id, resolvedBy: 'manual' }
  );

const releaseReviewItemClaim = async (reviewItemId) =>
  ReviewQueue.findByIdAndUpdate(reviewItemId, { resolvedClientId: null });

const resolveOneReviewItem = async (reviewItem, client) => {
  const claimed = await claimReviewItem(reviewItem._id, client);
  if (!claimed) {
    return { error: 'Already resolved' };
  }

  if (reviewItem.type === 'email') {
    const emailLog = await EmailLog.findById(reviewItem.referenceId);
    if (!emailLog) {
      await releaseReviewItemClaim(reviewItem._id);
      return { error: 'Underlying EmailLog not found for this review item' };
    }

    const isDelegated = emailLog.authMode === 'delegated';
    let accessToken;
    let mailboxEmail;

    if (isDelegated) {
      accessToken = await getAccessTokenFromRefreshToken();
    } else {
      mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
      if (!mailboxEmail) {
        await releaseReviewItemClaim(reviewItem._id);
        return { error: 'TEST_MAILBOX_EMAIL not configured - cannot re-fetch this email from Outlook.' };
      }
    }

    let savedAttachments = [];
    let categoryAssigned = false;
    let outlookCopySaved = false;
    let fileProcessingWarning;

    try {
      let workingMessageId = emailLog.currentMessageId || emailLog.messageId;
      const graphAttachments = await withResilientMessageId(emailLog, mailboxEmail, accessToken, (currentId) => {
        workingMessageId = currentId;
        return getEmailAttachments(mailboxEmail, currentId, accessToken);
      });
      const attachments = (graphAttachments || [])
        .filter((attachment) => attachment.contentBytes && !isInlineImageAttachment(attachment))
        .map((attachment) => ({ name: attachment.name, contentBase64: attachment.contentBytes }));

      const fileResult = await completeFileProcessing(
        { messageId: emailLog.messageId, liveMessageId: workingMessageId, attachments },
        client,
        accessToken,
        isDelegated,
        'manual'
      );
      savedAttachments = fileResult.savedAttachments;
      categoryAssigned = fileResult.categoryAssigned;
      outlookCopySaved = fileResult.outlookCopySaved;
    } catch (processingError) {
      console.error(
        `resolveOneReviewItem: could not fetch/file the attachment for EmailLog ${emailLog._id} - assigning anyway: ${processingError.message}`
      );
      fileProcessingWarning = `Assigned to ${client.name}, but the attachment could not be retrieved from the mailbox: ${processingError.message}`;
    }

    emailLog.matchedClientId = client._id;
    emailLog.status = 'processed';
    emailLog.categoryAssigned = categoryAssigned;
    emailLog.outlookCopySaved = outlookCopySaved;
    emailLog.attachments = savedAttachments;
    emailLog.processingError = fileProcessingWarning;
    emailLog.matchMethod = 'manual';
    await emailLog.save();

    return { error: null, warning: fileProcessingWarning };
  }

  if (reviewItem.type === 'file') {
    await FileLog.findByIdAndUpdate(reviewItem.referenceId, {
      clientId: client._id,
      status: 'moved',
      matchMethod: 'manual',
    });
    return { error: null };
  }

  return { error: `Unknown review-item type "${reviewItem.type}"` };
};

module.exports = { resolveOneReviewItem, claimReviewItem, releaseReviewItemClaim };
