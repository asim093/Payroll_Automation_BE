const EmailLog = require('../models/EmailLog');
const { findMessageIdByInternetMessageId } = require('./graphService');

const isItemNotFoundError = (error) => /404|ErrorItemNotFound/i.test(error?.message || '');

const withResilientMessageId = async (emailLog, mailboxEmail, accessToken, operation) => {
  const primaryId = emailLog.currentMessageId || emailLog.messageId;

  try {
    return await operation(primaryId);
  } catch (error) {
    if (!isItemNotFoundError(error) || !emailLog.internetMessageId) {
      throw error;
    }

    const freshId = await findMessageIdByInternetMessageId(mailboxEmail, emailLog.internetMessageId, accessToken);
    if (!freshId || freshId === primaryId) {
      throw error;
    }

    const result = await operation(freshId);

    emailLog.currentMessageId = freshId;
    EmailLog.updateOne({ _id: emailLog._id }, { currentMessageId: freshId }).catch((updateError) => {
      console.error(
        `withResilientMessageId: could not persist refreshed messageId for EmailLog ${emailLog._id}: ${updateError.message}`
      );
    });

    return result;
  }
};

module.exports = { withResilientMessageId, isItemNotFoundError };
