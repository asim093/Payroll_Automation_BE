const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const { getMessageBody, getEmailAttachments, isInlineImageAttachment } = require('../services/graphService');
const { getAccessTokenFromRefreshToken } = require('../services/delegatedAuthService');
const { withResilientMessageId } = require('../services/emailIdResolver');

const MAX_INLINE_IMAGE_BASE64_LENGTH = 2 * 1024 * 1024;

const embedInlineImages = (html, attachments) => {
  if (!html || !html.includes('cid:') || !Array.isArray(attachments) || attachments.length === 0) return html;
  let output = html;
  attachments.forEach((attachment) => {
    if (!attachment || !attachment.contentBytes) return;
    if (!isInlineImageAttachment(attachment)) return;
    if (attachment.contentBytes.length > MAX_INLINE_IMAGE_BASE64_LENGTH) return;
    const dataUri = `data:${attachment.contentType || 'application/octet-stream'};base64,${attachment.contentBytes}`;
    const tokens = [String(attachment.contentId || '').replace(/^<|>$/g, ''), attachment.name].filter(Boolean);
    tokens.forEach((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`cid:${escaped}`, 'gi'), dataUri);
    });
  });
  return output;
};

exports.getActivityDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const separatorIndex = id.indexOf('-');
    if (separatorIndex === -1) {
      return res.status(400).json({ error: 'Invalid activity id - expected format "email-<id>" or "file-<id>"' });
    }

    const type = id.slice(0, separatorIndex);
    const recordId = id.slice(separatorIndex + 1);

    if (type === 'email') {
      const emailLog = await EmailLog.findById(recordId).populate('matchedClientId', 'name status');
      if (!emailLog) {
        return res.status(404).json({ error: 'Email log not found' });
      }

      const files = await FileLog.find({ sourceMessageId: emailLog.messageId })
        .populate('clientId', 'name')
        .sort({ createdAt: 1 });

      return res.status(200).json({ type: 'email', email: emailLog, files });
    }

    if (type === 'file') {
      const fileLog = await FileLog.findById(recordId).populate('clientId', 'name status');
      if (!fileLog) {
        return res.status(404).json({ error: 'File log not found' });
      }

      const email = fileLog.sourceMessageId
        ? await EmailLog.findOne({ messageId: fileLog.sourceMessageId }).select('subject sender receivedAt matchMethod')
        : null;

      return res.status(200).json({ type: 'file', file: fileLog, email });
    }

    return res.status(400).json({ error: `Unknown activity type "${type}"` });
  } catch (error) {
    next(error);
  }
};

exports.getEmailBody = async (req, res, next) => {
  try {
    const emailLog = await EmailLog.findById(req.params.id);
    if (!emailLog) {
      return res.status(404).json({ error: 'Email log not found' });
    }

    const isDelegated = emailLog.authMode === 'delegated';
    let accessToken;
    let mailboxEmail;

    if (isDelegated) {
      accessToken = await getAccessTokenFromRefreshToken();
    } else {
      mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
      if (!mailboxEmail) {
        return res.status(503).json({ error: 'TEST_MAILBOX_EMAIL not configured - cannot re-fetch this email from Outlook.' });
      }
    }

    const body = await withResilientMessageId(emailLog, mailboxEmail, accessToken, (currentId) =>
      getMessageBody(mailboxEmail, currentId, accessToken)
    );

    if (body.internetMessageId && emailLog.internetMessageId !== body.internetMessageId) {
      emailLog.internetMessageId = body.internetMessageId;
      emailLog.save().catch((saveError) => {
        console.error(`getEmailBody: could not backfill internetMessageId for EmailLog ${emailLog._id}: ${saveError.message}`);
      });
    }

    let attachments = [];
    if (body.hasAttachments) {
      try {
        const graphAttachments = await withResilientMessageId(emailLog, mailboxEmail, accessToken, (currentId) =>
          getEmailAttachments(mailboxEmail, currentId, accessToken)
        );
        if (body.bodyContentType === 'html') {
          body.bodyContent = embedInlineImages(body.bodyContent, graphAttachments || []);
        }
        attachments = (graphAttachments || [])
          .filter((attachment) => !isInlineImageAttachment(attachment))
          .map((attachment) => ({
            name: attachment.name,
            size: attachment.size,
          }));
      } catch (attachmentError) {
        console.error(`getEmailBody: could not load attachment metadata: ${attachmentError.message}`);
      }
    }

    const { internetMessageId, ...bodyForResponse } = body;
    res.status(200).json({ ...bodyForResponse, attachments });
  } catch (error) {
    console.error(`getEmailBody ERROR (EmailLog ${req.params.id}): ${error.message}`);

    if (/404|ErrorItemNotFound/i.test(error.message)) {
      return res.status(404).json({
        error: 'This email is no longer in the mailbox - it looks like it was moved, archived, or deleted after it arrived, so the preview is no longer available.',
      });
    }

    if (/401|InvalidAuthenticationToken|invalid_grant|interaction_required/i.test(error.message)) {
      return res.status(401).json({
        error: 'The mailbox connection has expired or was revoked - reconnect it and try again.',
      });
    }

    res.status(502).json({ error: 'Could not load the email preview right now, please try again in a moment.' });
  }
};
