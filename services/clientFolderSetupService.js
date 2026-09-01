
const Client = require('../models/Client');
const { getSettings } = require('./settingsService');
const { joinFolderPath, resolveFolderPath } = require('../utils/folderPath');
const { ensureDropboxFolderExists } = require('./dropboxService');
const { ensureShareFileFolderExists } = require('./sharefileService');
const { findOrCreateOutlookFolder } = require('./graphService');
const { getAccessTokenFromRefreshToken, isDelegatedConfigAvailable } = require('./delegatedAuthService');
const { formatError } = require('../utils/formatError');

const normalizePathSegment = (value) => String(value || '').trim().toLowerCase();


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


const setupClientFolders = async (client) => {
  const warnings = await checkForPathCollisions(client);
  const { dropboxRootPath, shareFileRootPath, outlookRootPath, outlookClientSubfolder } = await getSettings();

  try {
    const dropboxSegment = client.dropboxPath || client.name;
    const result = await ensureDropboxFolderExists(dropboxSegment, client.dropboxPathIsAbsolute);
    console.log(
      `  [CLIENT SETUP] Dropbox "${result.path}" - ${result.created ? 'created' : 'already existed'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT SETUP] Dropbox folder-create FAILED for "${client.name}": ${message}`);
    warnings.push(`Dropbox: could not create the folder automatically, please check manually. (${message})`);
  }

  try {
    const shareFileSegment = client.shareFilePath || client.name;
    const resolvedPath = resolveFolderPath(shareFileRootPath, shareFileSegment, client.shareFilePathIsAbsolute);
    const result = await ensureShareFileFolderExists(resolvedPath);
    console.log(
      `  [CLIENT SETUP] ShareFile "${resolvedPath}" - ${result.created ? 'created' : 'already existed'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT SETUP] ShareFile folder-create FAILED for "${client.name}": ${message}`);
    warnings.push(`ShareFile: could not create the folder automatically, please check manually. (${message})`);
  }


  if (await isDelegatedConfigAvailable()) {
    try {
      const clientSegment = outlookClientSubfolder ? `${client.name}/${outlookClientSubfolder}` : client.name;
      const resolvedPath = joinFolderPath(outlookRootPath, clientSegment);
      const accessToken = await getAccessTokenFromRefreshToken();
      const folderId = await findOrCreateOutlookFolder(resolvedPath, accessToken, undefined);
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
