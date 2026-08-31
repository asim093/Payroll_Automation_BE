const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const ReviewQueue = require('../models/ReviewQueue');
const {
  matchClientBySender,
  matchClientByNotificationPattern,
  matchClientBySubjectKeyword,
  matchInactiveClientBySender,
  matchClientByDomainPendingReview,
} = require('./clientMatcher');
const { saveAttachmentToClientFolder } = require('./fileStorage');
const { uploadFileToDropbox } = require('./dropboxService');
const { fetchFileFromShareFile } = require('./sharefileService');
const { assignCategory, ensureCategoryExists, copyEmailToFolder } = require('./graphService');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');

const PROCESSED_CATEGORY_NAME = 'Processed';
const PROCESSED_CATEGORY_COLOR = 'preset1'; 

const saveToDestinations = async (client, fileName, contentBuffer, source, options = {}) => {
  const { sourceMessageId, sourceFileId, updateFileLogId, matchMethod } = options;
  const referenceDate = new Date();
  const uniqueFileName = generateUniqueFilename(fileName, referenceDate);

  const persistFileLog = (fields) => {
    if (updateFileLogId) {
      const setFields = {};
      const unsetFields = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          unsetFields[key] = '';
        } else {
          setFields[key] = value;
        }
      }
      const update = {};
      if (Object.keys(setFields).length) update.$set = setFields;
      if (Object.keys(unsetFields).length) update.$unset = unsetFields;
      return FileLog.findByIdAndUpdate(updateFileLogId, update, { new: true });
    }
    return FileLog.create({
      source,
      originalName: fileName,
      clientId: client._id,
      sourceMessageId,
      sourceFileId,
      matchMethod,
      ...fields,
    });
  };

  
  let dropboxError;

  try {
    const dropboxFolderSegment = client.dropboxPath || client.name;
    const dropboxPath = await uploadFileToDropbox(
      dropboxFolderSegment,
      fileName,
      contentBuffer,
      referenceDate,
      client.dropboxPathIsAbsolute
    );

    await persistFileLog({
      destinationPath: dropboxPath,
      destination: 'dropbox',
      status: 'moved',
      processedAt: new Date(),
      errorMessage: undefined,
      fallbackUsed: false,
    });
    console.log(`  [DROPBOX] "${fileName}" → ${dropboxPath} (FileLog ${updateFileLogId ? 'updated' : 'created'}).`);

    return { filename: uniqueFileName, size: contentBuffer.length };
  } catch (error) {
    dropboxError = error;
    console.error(`  [DROPBOX] ERROR uploading "${fileName}": ${dropboxError.message}`);
    console.log(`  [FALLBACK] Dropbox failed for "${fileName}" - falling back to local storage.`);
  }

  try {
    const localPath = saveAttachmentToClientFolder(
      client.name,
      { name: fileName, contentBase64: contentBuffer.toString('base64') },
      referenceDate
    );

    await persistFileLog({
      destinationPath: localPath,
      destination: 'local',
      status: 'moved',
      fallbackUsed: true,
      processedAt: new Date(),
      errorMessage: undefined,
    });
    console.log(`  [FILE SAVED] "${fileName}" → ${localPath} (FileLog ${updateFileLogId ? 'updated' : 'created'}, Dropbox fallback).`);

    return { filename: uniqueFileName, size: contentBuffer.length };
  } catch (localError) {
    
    console.error(`  [FILE SAVE] ERROR: "${fileName}" could not be saved locally either: ${localError.message}`);
    console.error(`  [FILE SAVE] "${fileName}" FAILED on both Dropbox and local storage.`);

    await persistFileLog({
      destination: 'local',
      status: 'failed',
      errorMessage: `Dropbox: ${dropboxError.message}; Local: ${localError.message}`,
      processedAt: new Date(),
    });

    return { filename: uniqueFileName, size: 0 };
  }
};

const completeFileProcessing = async (emailData, matchedClient, accessToken, isDelegated = false, matchMethod) => {
  const { messageId, attachments = [] } = emailData;


  const savedAttachments = [];
  const warnings = [];
  for (const attachment of attachments) {
    const contentBuffer = attachment.contentBase64
      ? Buffer.from(attachment.contentBase64, 'base64')
      : Buffer.alloc(0);

    if (contentBuffer.length === 0) {
      const warning = `Attachment "${attachment.name}" was empty or corrupt - skipped`;
      console.warn(`  [ATTACHMENT] ${warning}`);
      warnings.push(warning);
      continue;
    }

    const saved = await saveToDestinations(matchedClient, attachment.name, contentBuffer, 'outlook', {
      sourceMessageId: messageId,
      matchMethod,
    });
    savedAttachments.push(saved);
  }


  let categoryAssigned = false;

  if (isDelegated && accessToken) {
   
    try {
      await ensureCategoryExists(PROCESSED_CATEGORY_NAME, PROCESSED_CATEGORY_COLOR, accessToken, undefined);
    } catch (error) {
      console.error(`  [CATEGORY SETUP] ERROR ensuring category exists (delegated): ${error.message}`);
    }
    try {
      await assignCategory(undefined, messageId, PROCESSED_CATEGORY_NAME, accessToken);
      categoryAssigned = true;
      console.log(`  [CATEGORY] "Processed" category assigned to ${messageId} (delegated).`);
    } catch (error) {
      console.error(
        `  [CATEGORY] ERROR assigning category to ${messageId} (delegated): ${error.message}`
      );
    }
  } else {
    const mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
    if (!mailboxEmail) {
      console.log('  [CATEGORY] Mailbox not configured - category assignment skipped.');
    } else {
      try {
        await ensureCategoryExists(PROCESSED_CATEGORY_NAME, PROCESSED_CATEGORY_COLOR, undefined, mailboxEmail);
      } catch (error) {
        console.error(`  [CATEGORY SETUP] ERROR ensuring category exists: ${error.message}`);
      }
      try {
        await assignCategory(mailboxEmail, messageId, PROCESSED_CATEGORY_NAME);
        categoryAssigned = true;
        console.log(`  [CATEGORY] "Processed" category assigned to ${messageId}.`);
      } catch (error) {
        console.error(`  [CATEGORY] ERROR assigning category to ${messageId}: ${error.message}`);
      }
    }
  }

  let outlookCopySaved = false;

  if (savedAttachments.length > 0 && matchedClient.outlookFolderId) {
    try {
      if (isDelegated && accessToken) {
        await copyEmailToFolder(messageId, matchedClient.outlookFolderId, accessToken, undefined);
      } else {
        const mailboxEmail = process.env.TEST_MAILBOX_EMAIL;
        if (!mailboxEmail) {
          throw new Error('TEST_MAILBOX_EMAIL not configured - cannot copy via the app-only flow.');
        }
        await copyEmailToFolder(messageId, matchedClient.outlookFolderId, undefined, mailboxEmail);
      }
      outlookCopySaved = true;
      console.log(`  [OUTLOOK COPY] Filed a copy of ${messageId} into "${matchedClient.name}"'s mail folder.`);
    } catch (error) {
      console.error(
        `  [OUTLOOK COPY] ERROR copying ${messageId} into "${matchedClient.name}"'s mail folder: ${error.message}`
      );
    }
  } else if (savedAttachments.length > 0) {
    console.log(
      `  [OUTLOOK COPY] Skipped for "${matchedClient.name}" - no outlookFolderId on file (edit the client to (re-)run folder setup).`
    );
  }

  return { savedAttachments, categoryAssigned, outlookCopySaved, warnings };
};

const ATTACHMENT_MENTION_PATTERN = /\b(attach|attached|attachment|enclosed|enclosure)\b/i;

const processEmail = async (emailData, accessToken, isDelegated = false) => {
  const { messageId, sender, subject, bodyPreview, receivedDateTime, attachments = [] } = emailData;
  const authMode = isDelegated ? 'delegated' : 'app-only';

  const existing = await EmailLog.findOne({ messageId });
  if (existing) {
    console.log(`[DUPLICATE-SKIPPED] ${messageId} — already processed, skipping.`);
    return existing;
  }

  const activeClients = await Client.find({ status: 'active' });

  const notificationClient = await matchClientByNotificationPattern(sender, activeClients);
  if (notificationClient) {
    console.log(
      `[SHAREFILE NOTIFICATION] Detected for ${notificationClient.name} - fetching file from ShareFile...`
    );

    let emailLog;

    try {
      const { content: fileContent, fileName: shareFileFileName } = await fetchFileFromShareFile(
        notificationClient.shareFilePath || notificationClient.name,
        undefined,
        notificationClient.shareFilePathIsAbsolute
      );

      let savedAttachments = [];
      let warning;
      if (!fileContent || fileContent.length === 0) {
        warning = `Attachment "${shareFileFileName}" was empty or corrupt - skipped`;
        console.warn(`  [ATTACHMENT] ${warning}`);
      } else {
        const saved = await saveToDestinations(notificationClient, shareFileFileName, fileContent, 'sharefile', {
          sourceMessageId: messageId,
          matchMethod: 'notification_pattern',
        });
        savedAttachments = [saved];
      }

      emailLog = await EmailLog.create({
        messageId,
        sender,
        subject,
        receivedAt: receivedDateTime,
        matchedClientId: notificationClient._id,
        status: 'processed',
        categoryAssigned: false,
        attachments: savedAttachments,
        sourceType: 'sharefile_notification',
        authMode,
        processingError: warning,
        matchMethod: 'notification_pattern',
      });
      console.log(`[SHAREFILE NOTIFICATION] File retrieved and saved for ${notificationClient.name}.`);
    } catch (error) {
      console.error(
        `[SHAREFILE NOTIFICATION] ERROR fetching file for ${notificationClient.name}: ${error.message}`
      );
      emailLog = await EmailLog.create({
        messageId,
        sender,
        subject,
        receivedAt: receivedDateTime,
        matchedClientId: notificationClient._id,
        status: 'failed',
        categoryAssigned: false,
        attachments: [],
        sourceType: 'sharefile_notification',
        authMode,
        processingError: `ShareFile folder empty or not found for client "${notificationClient.name}": ${error.message}`,
      });
    }

    return emailLog;
  }

  const matchResult = await matchClientBySender(sender, activeClients);

  if (matchResult) {
    const { client: matchedClient, method: matchMethod } = matchResult;
    const { savedAttachments, categoryAssigned, outlookCopySaved, warnings } = await completeFileProcessing(
      { messageId, attachments },
      matchedClient,
      accessToken,
      isDelegated,
      matchMethod
    );

    const emailLog = await EmailLog.create({
      messageId,
      sender,
      subject,
      receivedAt: receivedDateTime,
      matchedClientId: matchedClient._id,
      status: 'processed',
      categoryAssigned,
      outlookCopySaved,
      attachments: savedAttachments,
      authMode,
      processingError: warnings.length ? warnings.join('; ') : undefined,
      matchMethod,
    });
    console.log(
      `[MATCHED] ${messageId} — sender "${sender}" matched client "${matchedClient.name}". EmailLog created (status: processed).`
    );
    return emailLog;
  }


  const hasAttachments = attachments.length > 0;
  const mentionsAttachment = ATTACHMENT_MENTION_PATTERN.test(`${subject || ''} ${bodyPreview || ''}`);

  if (!hasAttachments && !mentionsAttachment) {
    const emailLog = await EmailLog.create({
      messageId,
      sender,
      subject,
      receivedAt: receivedDateTime,
      matchedClientId: null,
      status: 'no_attachment_skipped',
      categoryAssigned: false,
      attachments: [],
      authMode,
    });

    console.log(
      `[NO ATTACHMENT - SKIPPED] ${messageId} — sender "${sender}" matched no client and has no attachments (subject/body also has no "attach"-style wording). EmailLog created (status: no_attachment_skipped), not added to Review Queue.`
    );
    return emailLog;
  }

  const possibleMissedAttachment = !hasAttachments && mentionsAttachment;

  const domainPendingMatch = possibleMissedAttachment ? null : await matchClientByDomainPendingReview(sender, activeClients);
  const subjectKeywordMatch =
    domainPendingMatch || possibleMissedAttachment ? null : await matchClientBySubjectKeyword(subject, activeClients);
  const inactiveMatch =
    domainPendingMatch || subjectKeywordMatch || possibleMissedAttachment
      ? null
      : await matchInactiveClientBySender(sender);
  const suggestedClient = domainPendingMatch || subjectKeywordMatch || inactiveMatch || null;
  const reason = possibleMissedAttachment
    ? 'possible_missed_attachment'
    : domainPendingMatch
    ? 'new_sender_domain_match'
    : subjectKeywordMatch
    ? 'subject_keyword_match'
    : inactiveMatch
    ? 'client_inactive'
    : 'no_match';

  const emailLog = await EmailLog.create({
    messageId,
    sender,
    subject,
    receivedAt: receivedDateTime,
    matchedClientId: null,
    status: 'needs_review',
    categoryAssigned: false,
    attachments: [],
    authMode,
  });

  await ReviewQueue.create({
    type: 'email',
    referenceId: emailLog._id,
    reason,
    suggestedClientId: suggestedClient?._id,
  });

  console.log(
    possibleMissedAttachment
      ? `[POSSIBLE MISSED ATTACHMENT] ${messageId} — sender "${sender}" matched no client; no attachment was captured but subject/body mentions one (likely a Graph API attachment-indexing delay). EmailLog created (status: needs_review) + ReviewQueue entry added (reason: possible_missed_attachment) — needs manual check.`
      : domainPendingMatch
      ? `[NEEDS REVIEW] ${messageId} — sender "${sender}" matches active client "${domainPendingMatch.name}" by domain, but this exact address has never been confirmed before. EmailLog created (status: needs_review) + ReviewQueue entry added (reason: new_sender_domain_match).`
      : subjectKeywordMatch
      ? `[NEEDS REVIEW] ${messageId} — subject matches a subject-keyword rule for client "${subjectKeywordMatch.name}". EmailLog created (status: needs_review) + ReviewQueue entry added (reason: subject_keyword_match) — keyword matches always need manual confirmation.`
      : inactiveMatch
      ? `[NEEDS REVIEW] ${messageId} — sender "${sender}" matches inactive client "${inactiveMatch.name}". EmailLog created (status: needs_review) + ReviewQueue entry added (reason: client_inactive).`
      : `[NEEDS REVIEW] ${messageId} — sender "${sender}" matched no client. EmailLog created (status: needs_review) + ReviewQueue entry added.`
  );
  return emailLog;
};

module.exports = { processEmail, completeFileProcessing, saveToDestinations };
