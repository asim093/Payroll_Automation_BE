
const Client = require('../models/Client');
const { getSettings } = require('./settingsService');
const { joinFolderPath, resolveFolderPath } = require('../utils/folderPath');
const { ensureDropboxFolderExists, renameDropboxFolder } = require('./dropboxService');
const { ensureShareFileFolderExists, renameShareFileFolder } = require('./sharefileService');
const { findOrCreateOutlookFolder, renameMailFolder } = require('./graphService');
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


const renameClientFolders = async (previousClient, client) => {
  const warnings = [];
  const { shareFileRootPath } = await getSettings();

  try {
    const result = await renameDropboxFolder(
      previousClient.dropboxPath || previousClient.name,
      previousClient.dropboxPathIsAbsolute,
      client.dropboxPath || client.name,
      client.dropboxPathIsAbsolute
    );
    if (result.renamed) {
      console.log(`  [CLIENT RENAME] Dropbox folder "${result.from}" -> "${result.to}".`);
    } else if (result.reason === 'target-exists') {
      warnings.push(
        'Dropbox: a folder already exists at the new path — the old folder was left in place, move its files over manually.'
      );
    } else if (result.reason === 'multi-segment-change' || result.reason === 'shape-changed') {
      warnings.push(
        'Dropbox: the folder path changed too much to rename automatically — the old folder was left in place, move its files over manually.'
      );
    }
  } catch (error) {
    warnings.push(
      `Dropbox: could not rename the folder automatically (${formatError(error)}). The old folder may need renaming manually.`
    );
  }

  try {
    const fromPath = resolveFolderPath(
      shareFileRootPath,
      previousClient.shareFilePath || previousClient.name,
      previousClient.shareFilePathIsAbsolute
    );
    const toPath = resolveFolderPath(
      shareFileRootPath,
      client.shareFilePath || client.name,
      client.shareFilePathIsAbsolute
    );
    const result = await renameShareFileFolder(fromPath, toPath);
    if (result.renamed) {
      console.log(`  [CLIENT RENAME] ShareFile folder "${result.from}" -> "${result.to}".`);
    } else if (result.reason === 'target-exists') {
      warnings.push(
        'ShareFile: a folder already exists at the new path — the old folder was left in place, move its files over manually.'
      );
    } else if (result.reason === 'multi-segment-change' || result.reason === 'shape-changed') {
      warnings.push(
        'ShareFile: the folder path changed too much to rename automatically — the old folder was left in place, move its files over manually.'
      );
    }
  } catch (error) {
    warnings.push(
      `ShareFile: could not rename the folder automatically (${formatError(error)}). The old folder may need renaming manually.`
    );
  }

  if (previousClient.outlookFolderId && previousClient.name !== client.name && (await isDelegatedConfigAvailable())) {
    try {
      const { outlookClientSubfolder } = await getSettings();
      if (outlookClientSubfolder) {
        warnings.push(
          'Outlook: the mail folder was not renamed automatically because a subfolder is configured — rename it in Outlook manually.'
        );
      } else {
        const accessToken = await getAccessTokenFromRefreshToken();
        await renameMailFolder(previousClient.outlookFolderId, client.name, accessToken, undefined);
        client.outlookFolderId = previousClient.outlookFolderId;
      }
    } catch (error) {
      warnings.push(
        `Outlook: could not rename the mail folder automatically (${formatError(error)}).`
      );
    }
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

module.exports = { setupClientFolders, renameClientFolders };
