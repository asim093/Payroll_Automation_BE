
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');
const { deleteDropboxFolder } = require('./dropboxService');
const { deleteShareFileFolder } = require('./sharefileService');
const { deleteMailFolder } = require('./graphService');
const { getAccessTokenFromRefreshToken, isDelegatedConfigAvailable } = require('./delegatedAuthService');
const { formatError } = require('../utils/formatError');


const deleteClientFolders = async (client) => {
  const warnings = [];
  const { shareFileRootPath } = await getSettings();

  try {
    const dropboxSegment = client.dropboxPath || client.name;
    const result = await deleteDropboxFolder(dropboxSegment);
    console.log(
      `  [CLIENT CLEANUP] Dropbox folder for "${client.name}" - ${result.deleted ? 'deleted' : 'did not exist'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT CLEANUP] Dropbox folder-delete FAILED for "${client.name}": ${message}`);
    warnings.push(`Dropbox: could not delete the folder automatically, please remove it manually. (${message})`);
  } 
  try {
    const shareFileSegment = client.shareFilePath || client.name;
    const resolvedPath = joinFolderPath(shareFileRootPath, shareFileSegment);
    const result = await deleteShareFileFolder(resolvedPath);
    console.log(
      `  [CLIENT CLEANUP] ShareFile folder for "${client.name}" - ${result.deleted ? 'deleted' : 'did not exist'}.`
    );
  } catch (error) {
    const message = formatError(error);
    console.error(`  [CLIENT CLEANUP] ShareFile folder-delete FAILED for "${client.name}": ${message}`);
    warnings.push(`ShareFile: could not delete the folder automatically, please remove it manually. (${message})`);
  }


  if ((await isDelegatedConfigAvailable()) && client.outlookFolderId) {
    try {
      const accessToken = await getAccessTokenFromRefreshToken();
      await deleteMailFolder(client.outlookFolderId, accessToken, undefined);
      console.log(`  [CLIENT CLEANUP] Outlook mail-folder for "${client.name}" deleted.`);
    } catch (error) {
      const message = formatError(error);
      console.error(`  [CLIENT CLEANUP] Outlook mail-folder delete FAILED for "${client.name}": ${message}`);
      warnings.push(`Outlook: could not delete the mail folder automatically, please remove it manually. (${message})`);
    }
  }

  return warnings;
};

module.exports = { deleteClientFolders };
