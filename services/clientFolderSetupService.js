
const Client = require('../models/Client');
const { getSettings } = require('./settingsService');
const { joinFolderPath, resolveFolderPath, resolveDropboxFolderPathSync } = require('../utils/folderPath');
const { findClientsSharingFolders, loadFolderIdentitySettings } = require('../utils/clientFolderIdentity');
const { ensureDropboxFolderExists, renameDropboxFolder, dropboxFolderContentCount } = require('./dropboxService');
const { ensureShareFileFolderExists, renameShareFileFolder, shareFileFolderChildCount } = require('./sharefileService');
const { findOrCreateOutlookFolder, renameMailFolder } = require('./graphService');
const { getAccessTokenFromRefreshToken, isDelegatedConfigAvailable } = require('./delegatedAuthService');
const { formatError } = require('../utils/formatError');


const checkForPathCollisions = async (client) => {
  const warnings = [];
  const settings = await loadFolderIdentitySettings();

  const otherClients = await Client.find({ _id: { $ne: client._id } })
    .select('name dropboxPath dropboxPathIsAbsolute shareFilePath shareFilePathIsAbsolute')
    .lean();

  const { dropbox, shareFile } = findClientsSharingFolders(client, otherClients, settings);

  if (dropbox.length > 0) {
    warnings.push(
      `Dropbox: this path is already used by client "${dropbox[0].name}" — files from both clients will land in the same folder.`
    );
  }
  if (shareFile.length > 0) {
    warnings.push(
      `ShareFile: this path is already used by client "${shareFile[0].name}" — files from both clients will land in the same folder.`
    );
  }

  return warnings;
};


const renameClientFolders = async (previousClient, client) => {
  const warnings = [];
  const { dropboxRootPath, shareFileRootPath } = await getSettings();
  const nameChanged = previousClient.name !== client.name;

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
    } else if (result.reason === 'unchanged' && nameChanged && String(client.dropboxPath || '').trim()) {
      const resolved = resolveDropboxFolderPathSync(
        dropboxRootPath,
        client.dropboxPath,
        Boolean(client.dropboxPathIsAbsolute)
      );
      warnings.push(
        `Dropbox: this client's folder stays at "${resolved}", which no longer matches the client name. Rename it in Dropbox manually if you want them to match.`
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
    } else if (result.reason === 'unchanged' && nameChanged && String(client.shareFilePath || '').trim()) {
      warnings.push(
        `ShareFile: this client's folder stays at "${toPath}", which no longer matches the client name. Rename it in ShareFile manually if you want them to match.`
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
  const notices = [];
  const { dropboxRootPath, shareFileRootPath, outlookRootPath, outlookClientSubfolder } = await getSettings();

  try {
    const dropboxSegment = client.dropboxPath || client.name;
    const result = await ensureDropboxFolderExists(dropboxSegment, client.dropboxPathIsAbsolute);
    console.log(
      `  [CLIENT SETUP] Dropbox "${result.path}" - ${result.created ? 'created' : 'already existed'}.`
    );
    if (!result.created) {
      const count = await dropboxFolderContentCount(dropboxSegment, client.dropboxPathIsAbsolute).catch(() => 0);
      const where = `"${result.path}"`;
      const contents = count > 0 ? ` (it already has ${count} item${count === 1 ? '' : 's'} in it)` : '';
      notices.push(
        `New clients normally get a Dropbox folder created automatically at client creation. A folder for this client already exists at ${where}${contents}, so it was linked instead of creating a new one. This client's generated reports will be saved there.`
      );
    }
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
    if (!result.created && result.folderId) {
      const count = await shareFileFolderChildCount(result.folderId);
      const where = `"${resolvedPath}"`;
      const contents = count > 0 ? ` (it already has ${count} item${count === 1 ? '' : 's'} in it)` : '';
      notices.push(
        `New clients normally get a ShareFile folder created automatically at client creation. A folder for this client already exists at ${where}${contents}, so it was linked instead of creating a new one. Incoming files for this client will be picked up from there.`
      );
    }
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

  return { warnings, notices };
};

module.exports = { setupClientFolders, renameClientFolders };
