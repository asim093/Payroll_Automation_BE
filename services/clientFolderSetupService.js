/**
 * PHASE 3 — client-add/edit-time folder existence-check + auto-create.
 *
 * Runs all three destination checks best-effort: a failure in one (or all)
 * NEVER blocks saving the client — see clientController.js, which always
 * saves first and calls this afterward. Each failure becomes one entry in
 * the returned `warnings` array, persisted onto Client.folderSetupWarnings
 * so it can be surfaced on the Clients page until manually resolved.
 */
const Client = require('../models/Client');
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');
const { ensureDropboxFolderExists } = require('./dropboxService');
const { ensureShareFileFolderExists } = require('./sharefileService');
const { findOrCreateOutlookFolder } = require('./graphService');
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
const { formatError } = require('../utils/formatError');

const hasDelegatedConfig = () =>
  Boolean(process.env.DELEGATED_REFRESH_TOKEN && process.env.DELEGATED_CLIENT_ID && process.env.DELEGATED_MAILBOX_EMAIL);

const normalizePathSegment = (value) => String(value || '').trim().toLowerCase();

/**
 * Two clients pointing at the exact same Dropbox/ShareFile path means their
 * files land in the same physical folder and get mixed together — this is
 * never intentional, but nothing else in the create/edit flow would catch
 * it (ensureXFolderExists() just sees "already exists" and reports no
 * warning). Checked independently of the create/exists calls below so it
 * still fires even when the folder itself was created without any error.
 *
 * @returns {Promise<string[]>} zero, one, or two warnings (Dropbox/ShareFile)
 */
const checkForPathCollisions = async (client) => {
  const warnings = [];
  const dropboxSegment = normalizePathSegment(client.dropboxPath || client.name);
  const shareFileSegment = normalizePathSegment(client.shareFilePath || client.name);

  const otherClients = await Client.find({ _id: { $ne: client._id } })
    .select('name dropboxPath shareFilePath')
    .lean();

  const dropboxCollision = otherClients.find(
    (other) => normalizePathSegment(other.dropboxPath || other.name) === dropboxSegment
  );
  if (dropboxCollision) {
    warnings.push(
      `Dropbox: this path is already used by client "${dropboxCollision.name}" — files from both clients will land in the same folder.`
    );
  }

  const shareFileCollision = otherClients.find(
    (other) => normalizePathSegment(other.shareFilePath || other.name) === shareFileSegment
  );
  if (shareFileCollision) {
    warnings.push(
      `ShareFile: this path is already used by client "${shareFileCollision.name}" — files from both clients will land in the same folder.`
    );
  }

  return warnings;
};

/**
 * @param {import('../models/Client')} client - a saved Client document (or
 *   plain object) with name/dropboxPath/shareFilePath already set.
 * @returns {Promise<string[]>} warnings - empty array means everything
 *   checked out (or was created) fine.
 */
const setupClientFolders = async (client) => {
  const warnings = await checkForPathCollisions(client);
  const { dropboxRootPath, shareFileRootPath, outlookRootPath } = await getSettings();

  // --- Dropbox ---
  try {
    const dropboxSegment = client.dropboxPath || client.name;
    const result = await ensureDropboxFolderExists(dropboxSegment);
    console.log(
      `  [CLIENT SETUP] Dropbox "${result.path}" - ${result.created ? 'created' : 'already existed'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT SETUP] Dropbox folder-create FAILED for "${client.name}": ${message}`);
    warnings.push(`Dropbox: could not create the folder automatically, please check manually. (${message})`);
  }

  // --- ShareFile ---
  try {
    const shareFileSegment = client.shareFilePath || client.name;
    const resolvedPath = joinFolderPath(shareFileRootPath, shareFileSegment);
    const result = await ensureShareFileFolderExists(resolvedPath);
    console.log(
      `  [CLIENT SETUP] ShareFile "${resolvedPath}" - ${result.created ? 'created' : 'already existed'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT SETUP] ShareFile folder-create FAILED for "${client.name}": ${message}`);
    warnings.push(`ShareFile: could not create the folder automatically, please check manually. (${message})`);
  }

  // --- Outlook ---
  // Only attempted when the delegated flow is configured — same guard
  // runAllFlows.js uses before running the delegated email flow at all.
  if (hasDelegatedConfig()) {
    try {
      const resolvedPath = joinFolderPath(outlookRootPath, client.name);
      const accessToken = await getAccessTokenFromRefreshToken();
      const folderId = await findOrCreateOutlookFolder(resolvedPath, accessToken, undefined);
      // PHASE 11 — cached on the client so emailProcessor.js's per-email
      // copy-to-folder step can just read this field instead of re-walking
      // the folder path via Graph on every single email (see that field's
      // own comment on models/Client.js).
      client.outlookFolderId = folderId;
      console.log(`  [CLIENT SETUP] Outlook mail-folder "${resolvedPath}" ensured (id cached).`);
    } catch (error) {
      const message = formatError(error);
      console.error(`  [CLIENT SETUP] Outlook mail-folder create FAILED for "${client.name}": ${message}`);
      warnings.push(`Outlook: could not create the mail folder automatically, please check manually. (${message})`);
    }
  } else {
    console.log('  [CLIENT SETUP] Outlook: delegated flow not configured - skipping mail-folder creation.');
  }

  return warnings;
};

module.exports = { setupClientFolders };
