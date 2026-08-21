const ReviewQueue = require('../models/ReviewQueue');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const Client = require('../models/Client');
const { getEmailAttachments } = require('../services/graphService');
const { getAccessTokenFromRefreshToken } = require('../services/delegatedAuthService');
const { completeFileProcessing } = require('../services/emailProcessor');

const VALID_TYPES = ['email', 'file'];
const VALID_REASONS = ['unknown_sender', 'no_match', 'ambiguous', 'client_inactive', 'new_sender_domain_match'];

exports.createReviewQueueEntry = async (req, res, next) => {
  try {
    const { type, referenceId, reason } = req.body;

    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type is required and must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!referenceId) {
      return res.status(400).json({ error: 'referenceId is required' });
    }
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: `reason is required and must be one of: ${VALID_REASONS.join(', ')}` });
    }

    const entry = await ReviewQueue.create(req.body);
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
};

const attachRelatedData = async (entries) => {
  const emailIds = entries.filter((entry) => entry.type === 'email').map((entry) => entry.referenceId);
  const fileIds = entries.filter((entry) => entry.type === 'file').map((entry) => entry.referenceId);

  const [emailLogs, fileLogs] = await Promise.all([
    emailIds.length
      ? EmailLog.find({ _id: { $in: emailIds } }).select('sender subject receivedAt')
      : [],
    fileIds.length
      ? FileLog.find({ _id: { $in: fileIds } }).select('originalName destinationPath status')
      : [],
  ]);

  const emailMap = new Map(emailLogs.map((log) => [String(log._id), log]));
  const fileMap = new Map(fileLogs.map((log) => [String(log._id), log]));

  return entries.map((entry) => {
    if (entry.type === 'email') {
      const email = emailMap.get(String(entry.referenceId));
      return {
        ...entry,
        relatedEmail: email
          ? { sender: email.sender, subject: email.subject, receivedAt: email.receivedAt }
          : null,
      };
    }
    if (entry.type === 'file') {
      const file = fileMap.get(String(entry.referenceId));
      return {
        ...entry,
        relatedFile: file
          ? { originalName: file.originalName, destinationPath: file.destinationPath, status: file.status }
          : null,
      };
    }
    return entry;
  });
};

exports.getAllReviewQueueEntries = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { resolvedClientId: null };
    const entries = await ReviewQueue.find(filter)
      .populate('resolvedClientId')
      .populate('suggestedClientId')
      .lean();
    const enriched = await attachRelatedData(entries);
    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};

exports.getReviewQueueEntryById = async (req, res, next) => {
  try {
    const entry = await ReviewQueue.findById(req.params.id)
      .populate('resolvedClientId')
      .populate('suggestedClientId')
      .lean();
    if (!entry) {
      return res.status(404).json({ error: 'Review queue entry not found' });
    }
    const [enriched] = await attachRelatedData([entry]);
    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};

exports.updateReviewQueueEntry = async (req, res, next) => {
  try {
    const entry = await ReviewQueue.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!entry) {
      return res.status(404).json({ error: 'Review queue entry not found' });
    }
    res.status(200).json(entry);
  } catch (error) {
    next(error);
  }
};

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

    try {

      const isDelegated = emailLog.authMode === 'delegated';
      let accessToken;
      let mailboxEmail;

      if (isDelegated) {
        accessToken = await getAccessTokenFromRefreshToken();
      } else {
        mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
        if (!mailboxEmail) {
          throw new Error('TEST_MAILBOX_EMAIL not configured - cannot re-fetch this email from Outlook.');
        }
      }

      const graphAttachments = await getEmailAttachments(mailboxEmail, emailLog.messageId, accessToken);
      const attachments = (graphAttachments || [])
        .filter((attachment) => attachment.contentBytes)
        .map((attachment) => ({ name: attachment.name, contentBase64: attachment.contentBytes }));

      const { savedAttachments, categoryAssigned, outlookCopySaved } = await completeFileProcessing(
        { messageId: emailLog.messageId, attachments },
        client,
        accessToken,
        isDelegated
      );

      emailLog.matchedClientId = client._id;
      emailLog.status = 'processed';
      emailLog.categoryAssigned = categoryAssigned;
      emailLog.outlookCopySaved = outlookCopySaved;
      emailLog.attachments = savedAttachments;
      emailLog.processingError = undefined;
      await emailLog.save();

      return { error: null };
    } catch (processingError) {
      console.error(
        `resolveOneReviewItem: file-processing failed for EmailLog ${emailLog._id}: ${processingError.message}`
      );
      emailLog.status = 'failed';
      emailLog.processingError = processingError.message;
      await emailLog.save();
      await releaseReviewItemClaim(reviewItem._id);
      return { error: processingError.message };
    }
  }

  if (reviewItem.type === 'file') {
    await FileLog.findByIdAndUpdate(reviewItem.referenceId, {
      clientId: client._id,
      status: 'moved',
    });
    return { error: null };
  }

  return { error: `Unknown review-item type "${reviewItem.type}"` };
};

exports.resolveReviewItem = async (req, res, next) => {
  try {
    const { clientId } = req.body;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const reviewItem = await ReviewQueue.findById(req.params.id);
    if (!reviewItem) {
      return res.status(404).json({ error: 'Review queue entry not found' });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { error } = await resolveOneReviewItem(reviewItem, client);
    if (error) {
      return res.status(502).json({ error });
    }

    const updatedReviewItem = await ReviewQueue.findById(reviewItem._id).populate('resolvedClientId');
    res.status(200).json(updatedReviewItem);
  } catch (error) {
    next(error);
  }
};

exports.bulkResolveReviewItems = async (req, res, next) => {
  try {
    const { entryIds, clientId } = req.body;
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return res.status(400).json({ error: 'entryIds must be a non-empty array' });
    }
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const results = [];
    for (const entryId of entryIds) {
      const reviewItem = await ReviewQueue.findById(entryId);
      if (!reviewItem) {
        results.push({ entryId, success: false, error: 'Review queue entry not found' });
        continue;
      }

      const { error } = await resolveOneReviewItem(reviewItem, client);
      results.push({ entryId, success: !error, error: error || undefined });
    }

    const succeeded = results.filter((result) => result.success).length;
    res.status(200).json({ succeeded, failed: results.length - succeeded, results });
  } catch (error) {
    next(error);
  }
};

exports.deleteReviewQueueEntry = async (req, res, next) => {
  try {
    const entry = await ReviewQueue.findByIdAndDelete(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Review queue entry not found' });
    }
    res.status(200).json({ message: 'Review queue entry deleted successfully' });
  } catch (error) {
    next(error);
  }
};
