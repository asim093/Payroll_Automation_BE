const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const ReviewQueue = require('../models/ReviewQueue');
const {
  matchClientBySender,
  matchClientByNotificationPattern,
  matchInactiveClientBySender,
} = require('./clientMatcher');
const { saveAttachmentToClientFolder } = require('./fileStorage');
const { uploadFileToDropbox } = require('./dropboxService');
const { fetchFileFromShareFile } = require('./sharefileService');
// moveEmailToFolder is NOT imported here — emails intentionally stay in
// their original Outlook location. copyEmailToFolder (Phase 11) is
// different: it LEAVES the original in place and files an extra COPY into
// the client's dedicated folder - see completeFileProcessing() below.
const { assignCategory, ensureCategoryExists, copyEmailToFolder } = require('./graphService');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');

const PROCESSED_CATEGORY_NAME = 'Processed';
const PROCESSED_CATEGORY_COLOR = 'preset1'; // Orange — see graphService.ensureCategoryExists doc comment

/**
 * Saves a file to exactly one destination: Dropbox is tried FIRST, and
 * local disk is only used as a fallback when Dropbox genuinely fails
 * (missing/expired token, network issue, etc) — not as a second always-on
 * copy. This keeps a single FileLog entry per attachment in the normal case
 * instead of two. Shared by the normal Outlook-attachment flow and the
 * ShareFile flow below so this logic only lives in one place.
 *
 * The filename gets a timestamp prefix (see generateUniqueFilename) so two
 * attachments that happen to share an original name never overwrite each
 * other, on either destination.
 *
 * NOTE: contentBuffer is only ever held in memory for the duration of this
 * call — if both destinations fail, the bytes are gone (not persisted
 * anywhere). That's why a later retry (see services/fileRetryService.js)
 * has to re-fetch the original content from its actual source rather than
 * simply re-attempting the same upload.
 *
 * @param {object} [options]
 * @param {string} [options.sourceMessageId] - Graph messageId, for source
 *   'outlook' - lets a failed save be retried later by re-fetching this
 *   exact attachment from that email.
 * @param {string} [options.sourceFileId] - ShareFile item Id, for source
 *   'sharefile' - same idea, via downloadFileContentById().
 * @param {string} [options.updateFileLogId] - if given, UPDATES that
 *   existing FileLog in place instead of creating a new one — used by a
 *   retry, so the dashboard doesn't accumulate a duplicate row per attempt.
 * @returns {Promise<{filename: string, size: number}>}
 */
const saveToDestinations = async (client, fileName, contentBuffer, source, options = {}) => {
  const { sourceMessageId, sourceFileId, updateFileLogId } = options;
  const referenceDate = new Date();
  const uniqueFileName = generateUniqueFilename(fileName, referenceDate);

  const persistFileLog = (fields) => {
    if (updateFileLogId) {
      // Mongoose silently DROPS any key whose value is `undefined` from an
      // update object (same as JSON.stringify) — passing `errorMessage:
      // undefined` here would NOT clear a previous failure's error message
      // on a successful retry, it would just leave the old value sitting
      // there untouched. $unset is what actually removes a field, so any
      // `undefined` gets converted into an explicit $unset instead of
      // silently doing nothing.
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
      ...fields,
    });
  };

  // Declared outside the try so the "both failed" branch below can still
  // reference the Dropbox error alongside the local one.
  let dropboxError;

  // 1. Try Dropbox first.
  try {
    const dropboxFolderSegment = client.dropboxPath || client.name;
    const dropboxPath = await uploadFileToDropbox(dropboxFolderSegment, fileName, contentBuffer, referenceDate);

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

  // 2. Dropbox failed (for any reason) -> fall back to local disk.
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
    // 3. Both destinations failed — the file genuinely isn't saved
    // anywhere. Recorded (not thrown) so one bad attachment doesn't take
    // down the rest of the email's processing, consistent with how
    // category/move failures are handled elsewhere in this pipeline.
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

/**
 * Runs the full "matched client" file pipeline for an email: save each
 * attachment (local + optional Dropbox), assign a "Processed" category on
 * the live mailbox, and (Phase 11) file a COPY of the email into the
 * client's dedicated Outlook mail folder. The ORIGINAL email is always left
 * where it is (Inbox) — only a file-copy travels to Dropbox/local, and only
 * an email-COPY (never the original) travels to the client's folder. Shared
 * by processEmail() (automatic matching) and
 * reviewQueueController.resolveReviewItem() (manual review-queue
 * assignment) so this logic only lives in one place.
 *
 * Does NOT create or update any EmailLog itself — callers persist
 * { savedAttachments, categoryAssigned, outlookCopySaved } however fits
 * their case (create a new EmailLog vs. update an existing needs_review one).
 *
 * @param {object} emailData - only messageId and attachments are used
 * @param {object} matchedClient - Client document (needs _id, name, outlookFolderId)
 * @param {string} [accessToken] - delegated Graph token; ignored unless isDelegated is true
 * @param {boolean} [isDelegated] - false/omitted uses the app-only flow (TEST_MAILBOX_EMAIL)
 * @returns {Promise<{savedAttachments: object[], categoryAssigned: boolean, outlookCopySaved: boolean, warnings: string[]}>}
 *   warnings holds one message per empty/corrupt attachment that got
 *   skipped — the email still gets matched/processed normally (the sender
 *   match was correct), the caller just records these as a note.
 */
const completeFileProcessing = async (emailData, matchedClient, accessToken, isDelegated = false) => {
  const { messageId, attachments = [] } = emailData;

  // 1. Save attachments (local + optional Dropbox), skipping any that are
  // empty/corrupt — a 0-byte or missing content-buffer isn't a real file,
  // and saving/uploading it would just create a useless FileLog entry.
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
    });
    savedAttachments.push(saved);
  }

  // 2. Assign a "Processed" category on the live mailbox, if one is
  // reachable. Not critical to the pipeline — files are already saved, so a
  // failure here is logged but never thrown.
  let categoryAssigned = false;

  if (isDelegated && accessToken) {
    // Delegated flow — Graph as "me" (the signed-in user from
    // getRefreshToken.js), no TEST_MAILBOX_EMAIL involved.
    try {
      // Make sure the category exists WITH a color before assigning it —
      // does nothing if it's already there (won't touch an existing color).
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
    // App-only flow (default, backward-compatible) — only if a mailbox is configured.
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

  // Note: emails are intentionally NOT MOVED out of their original Outlook
  // location (Inbox) — boss confirmed only the file/attachment copy should
  // travel to Dropbox/local, the email itself stays put. (There used to be
  // an Outlook-folder-MOVE step here; see graphService.js's
  // findOrCreateOutlookFolder()/moveEmailToFolder() for why it's kept but
  // unused.) The COPY step below is different in kind, not degree: it never
  // touches the original, it only creates an extra copy elsewhere.

  // 3. PHASE 11 — file a COPY of this email into the client's dedicated
  // Outlook mail folder (auto-created at client-add time - see
  // clientFolderSetupService.js), so the team gets an organized client-wise
  // view inside Outlook itself, and a future cross-check/detection feature
  // has a concrete reference point to build on. Gated on at least one
  // attachment having actually been saved — an email with zero real
  // attachments has nothing attachment-related to "back up" this way, so
  // there's no folder-copy to make for it (only categorization applies).
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

/**
 * Orchestrates the processing of a single incoming email:
 * 1. Skip if this messageId was already processed (duplicate).
 * 2. Detect ShareFile "new item" notification emails (no attachments,
 *    sent from a service like Logiforms) and log them separately —
 *    actual S: drive file access isn't wired up yet, so this is
 *    detection/logging only.
 * 3. Try to match the sender to a client (normal attachment flow).
 * 4. Matched  -> completeFileProcessing() (save attachments, category —
 *    the email itself is never moved), then create an EmailLog with
 *    status 'processed'.
 * 5. Unmatched -> create an EmailLog with status 'needs_review' and a
 *    corresponding ReviewQueue entry.
 *
 * @param {object} emailData
 * @param {string} [accessToken] - delegated Graph token (from
 *   delegatedAuthService.getAccessTokenFromRefreshToken()); only used when
 *   isDelegated is true. Ignored otherwise.
 * @param {boolean} [isDelegated] - false/omitted (default) keeps the
 *   original app-only behavior: category assignment uses TEST_MAILBOX_EMAIL
 *   and graphService's own app-only token. When true, category assignment
 *   instead calls Graph as "me" using accessToken — see
 *   processInboxDelegated.js. processInbox.js calls this with neither
 *   param, unchanged, so it stays on the app-only path.
 */
const processEmail = async (emailData, accessToken, isDelegated = false) => {
  const { messageId, sender, subject, receivedDateTime, attachments = [] } = emailData;
  const authMode = isDelegated ? 'delegated' : 'app-only';

  // 1. Duplicate check
  const existing = await EmailLog.findOne({ messageId });
  if (existing) {
    console.log(`[DUPLICATE-SKIPPED] ${messageId} — already processed, skipping.`);
    return existing;
  }

  // 2. DEPRECATED - boss ne confirm kiya hai ki ShareFile ko notification ke
  // bajaye directly scheduled-scan se check karna hai (processShareFileScan.js
  // dekhein). Ye purana notification-based-detection ab active-flow mein use
  // nahi hota (nayi files scan se hi milti hain), lekin reference/rollback
  // ke liye rakha hai — agar kabhi koi purani/stray notification-email aaye
  // to bhi wo yahan gracefully handle ho jaati hai, bas hum ab isi par
  // depend nahi kar rahe naye files detect karne ke liye.
  const notificationClient = await matchClientByNotificationPattern(sender);
  if (notificationClient) {
    console.log(
      `[SHAREFILE NOTIFICATION] Detected for ${notificationClient.name} - fetching file from ShareFile...`
    );

    let emailLog;

    try {
      const { content: fileContent, fileName: shareFileFileName } = await fetchFileFromShareFile(
        notificationClient.shareFilePath || notificationClient.name
      );

      let savedAttachments = [];
      let warning;
      if (!fileContent || fileContent.length === 0) {
        warning = `Attachment "${shareFileFileName}" was empty or corrupt - skipped`;
        console.warn(`  [ATTACHMENT] ${warning}`);
      } else {
        const saved = await saveToDestinations(notificationClient, shareFileFileName, fileContent, 'sharefile');
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
      });
      console.log(`[SHAREFILE NOTIFICATION] File retrieved and saved for ${notificationClient.name}.`);
    } catch (error) {
      // Covers e.g. the client's ShareFile folder not existing or being
      // empty — genuinely nothing to fetch, not a transient glitch, so this
      // stays a clean 'failed' EmailLog rather than crashing processEmail().
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

  // 3. Try to match a client by sender (normal attachment flow)
  const matchedClient = await matchClientBySender(sender);

  if (matchedClient) {
    // 4. Matched -> run the shared file-processing pipeline, then log it.
    const { savedAttachments, categoryAssigned, outlookCopySaved, warnings } = await completeFileProcessing(
      { messageId, attachments },
      matchedClient,
      accessToken,
      isDelegated
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
      // The match itself was correct, so status stays 'processed' even if
      // every attachment turned out empty/corrupt — this is just a note for
      // whoever reviews the dashboard, not a failure.
      processingError: warnings.length ? warnings.join('; ') : undefined,
    });
    console.log(
      `[MATCHED] ${messageId} — sender "${sender}" matched client "${matchedClient.name}". EmailLog created (status: processed).`
    );
    return emailLog;
  }

  // 5. No match -> needs_review + ReviewQueue entry. Distinguish "this
  // sender belongs to a known client that's currently inactive" from a
  // genuinely unknown sender — different situations, different action for
  // whoever resolves the queue.
  const inactiveMatch = await matchInactiveClientBySender(sender);
  const reason = inactiveMatch ? 'client_inactive' : 'no_match';

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
  });

  console.log(
    inactiveMatch
      ? `[NEEDS REVIEW] ${messageId} — sender "${sender}" matches inactive client "${inactiveMatch.name}". EmailLog created (status: needs_review) + ReviewQueue entry added (reason: client_inactive).`
      : `[NEEDS REVIEW] ${messageId} — sender "${sender}" matched no client. EmailLog created (status: needs_review) + ReviewQueue entry added.`
  );
  return emailLog;
};

module.exports = { processEmail, completeFileProcessing, saveToDestinations };
