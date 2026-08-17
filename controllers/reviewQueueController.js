const ReviewQueue = require('../models/ReviewQueue');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const Client = require('../models/Client');
const { getEmailAttachments } = require('../services/graphService');
const { getAccessTokenFromRefreshToken } = require('../services/delegatedAuthService');
const { completeFileProcessing } = require('../services/emailProcessor');

const VALID_TYPES = ['email', 'file'];
const VALID_REASONS = ['unknown_sender', 'no_match', 'ambiguous', 'client_inactive'];

// @desc    Create a new review queue entry
// @route   POST /api/review-queue
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

// referenceId is a plain ObjectId (not a typed ref) because it can point to
// either an EmailLog or a FileLog depending on `type`, so Mongoose can't
// auto-populate it. This batches one extra query per type (not one per row)
// and attaches a `relatedEmail`/`relatedFile` summary — mainly sender/subject
// for email items — so the dashboard can show which email/file an entry
// actually is instead of just an opaque type/reason pair.
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

// @desc    Get all review queue entries. Resolved items (resolvedClientId
//          set) are excluded by default since the dashboard's Review Queue
//          is meant to show pending items only; pass ?all=true to get everything.
// @route   GET /api/review-queue
exports.getAllReviewQueueEntries = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { resolvedClientId: null };
    const entries = await ReviewQueue.find(filter).populate('resolvedClientId').lean();
    const enriched = await attachRelatedData(entries);
    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};

// @desc    Get single review queue entry by id
// @route   GET /api/review-queue/:id
exports.getReviewQueueEntryById = async (req, res, next) => {
  try {
    const entry = await ReviewQueue.findById(req.params.id).populate('resolvedClientId').lean();
    if (!entry) {
      return res.status(404).json({ error: 'Review queue entry not found' });
    }
    const [enriched] = await attachRelatedData([entry]);
    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};

// @desc    Update a review queue entry
// @route   PUT /api/review-queue/:id
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

// @desc    Resolve a review queue entry by assigning it to a client.
//          For type "email", this runs the SAME file-processing pipeline
//          that automatic matching uses (completeFileProcessing) — not
//          just a status update — so a manually-resolved email ends up
//          attachment-saved, categorized, and Outlook-folder-moved exactly
//          like an automatic match. For type "file", it's still just a
//          status update (out of scope for this pipeline right now).
// @route   PATCH /api/review-queue/:id/resolve
// @body    { clientId }
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

    if (reviewItem.type === 'email') {
      const emailLog = await EmailLog.findById(reviewItem.referenceId);
      if (!emailLog) {
        return res.status(404).json({ error: 'Underlying EmailLog not found for this review item' });
      }

      try {
        // needs_review EmailLogs never had their attachment content saved
        // anywhere (only matched emails get that far) — Outlook is the only
        // remaining source of truth, so re-fetch from there via Graph.
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

        // If the email had no attachments (or none anymore), this just
        // resolves to an empty array — completeFileProcessing() then
        // gracefully skips straight to category+move, no special-casing needed.
        const graphAttachments = await getEmailAttachments(mailboxEmail, emailLog.messageId, accessToken);
        const attachments = (graphAttachments || [])
          .filter((attachment) => attachment.contentBytes)
          .map((attachment) => ({ name: attachment.name, contentBase64: attachment.contentBytes }));

        const { savedAttachments, categoryAssigned } = await completeFileProcessing(
          { messageId: emailLog.messageId, attachments },
          client,
          accessToken,
          isDelegated
        );

        emailLog.matchedClientId = client._id;
        emailLog.status = 'processed';
        emailLog.categoryAssigned = categoryAssigned;
        emailLog.attachments = savedAttachments;
        emailLog.processingError = undefined;
        await emailLog.save();

        reviewItem.resolvedClientId = client._id;
        reviewItem.resolvedBy = 'manual'; // hardcoded until auth adds a real user
        await reviewItem.save();
      } catch (processingError) {
        console.error(
          `resolveReviewItem: file-processing failed for EmailLog ${emailLog._id}: ${processingError.message}`
        );
        emailLog.status = 'failed';
        emailLog.processingError = processingError.message;
        await emailLog.save();
        // ReviewQueue is intentionally left unresolved (no resolvedClientId)
        // so it stays visible in the pending queue and can be retried.
        return res.status(502).json({ error: processingError.message });
      }
    } else if (reviewItem.type === 'file') {
      reviewItem.resolvedClientId = client._id;
      reviewItem.resolvedBy = 'manual';
      await reviewItem.save();

      await FileLog.findByIdAndUpdate(reviewItem.referenceId, {
        clientId: client._id,
        status: 'moved',
      });
    }

    const updatedReviewItem = await ReviewQueue.findById(reviewItem._id).populate(
      'resolvedClientId'
    );
    res.status(200).json(updatedReviewItem);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a review queue entry
// @route   DELETE /api/review-queue/:id
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
