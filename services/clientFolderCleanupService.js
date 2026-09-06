
const Client = require('../models/Client');
const { resolveFolderPath, resolveDropboxFolderPathSync } = require('../utils/folderPath');
const { findClientsSharingFolders, loadFolderIdentitySettings } = require('../utils/clientFolderIdentity');
const { deleteDropboxFolder } = require('./dropboxService');
const { deleteShareFileFolder } = require('./sharefileService');
const { deleteMailFolder } = require('./graphService');
const { getAccessTokenFromRefreshToken, isDelegatedConfigAvailable } = require('./delegatedAuthService');
const { formatError } = require('../utils/formatError');

const listSharerNames = (clients) => clients.map((other) => `"${other.name}"`).join(', ');


const deleteClientFolders = async (client) => {
  const warnings = [];
  const settings = await loadFolderIdentitySettings();
  const { shareFileRootPath } = settings;

  // The folder locations this client resolves to, logged verbatim so an incident
  // review can see exactly which folder each line acted on (not just the client
  // name — after a path merge the two diverge).
  const dropboxResolved = resolveDropboxFolderPathSync(
    settings.dropboxRootPath,
    client.dropboxPath || client.name,
    Boolean(client.dropboxPathIsAbsolute)
  );
  const shareFileResolved = resolveFolderPath(
    shareFileRootPath,
    client.shareFilePath || client.name,
    Boolean(client.shareFilePathIsAbsolute)
  );

  // Ownership guard for BUG-13: if another client currently resolves to the same
  // Dropbox or ShareFile folder as this one (paths merged via a collision), then
  // deleting that folder here would permanently destroy the other client's files.
  // Skip the physical delete for any shared folder and report it. The caller still
  // removes this client record — only the folder deletion is unsafe, not the rest.
  const otherClients = await Client.find({ _id: { $ne: client._id } })
    .select('name dropboxPath dropboxPathIsAbsolute shareFilePath shareFilePathIsAbsolute')
    .lean();
  const { dropbox: dropboxSharers, shareFile: shareFileSharers } = findClientsSharingFolders(
    client,
    otherClients,
    settings
  );

  if (dropboxSharers.length > 0) {
    const names = listSharerNames(dropboxSharers);
    console.log(
      `  [CLIENT CLEANUP] Dropbox folder "${dropboxResolved}" (requested for client "${client.name}") NOT deleted — also used by client ${names}. Left in place.`
    );
    warnings.push(
      `Dropbox folder was kept because it is also used by client ${names} — deleting it would remove that client's files too.`
    );
  } else {
    try {
      const result = await deleteDropboxFolder(client.dropboxPath || client.name, client.dropboxPathIsAbsolute);
      console.log(
        `  [CLIENT CLEANUP] Dropbox folder "${result.path}" (requested for client "${client.name}") - ${result.deleted ? 'deleted' : 'did not exist'}.`
      );
    } catch (error) {
      const message = formatError(error);
      console.error(`  [CLIENT CLEANUP] Dropbox folder-delete FAILED for "${client.name}" ("${dropboxResolved}"): ${message}`);
      warnings.push(`Dropbox: could not delete the folder automatically, please remove it manually. (${message})`);
    }
  }

  if (shareFileSharers.length > 0) {
    const names = listSharerNames(shareFileSharers);
    console.log(
      `  [CLIENT CLEANUP] ShareFile folder "${shareFileResolved}" (requested for client "${client.name}") NOT deleted — also used by client ${names}. Left in place.`
    );
    warnings.push(
      `ShareFile folder was kept because it is also used by client ${names} — deleting it would remove that client's files too.`
    );
  } else {
    try {
      const result = await deleteShareFileFolder(shareFileResolved);
      console.log(
        `  [CLIENT CLEANUP] ShareFile folder "${shareFileResolved}"${result.folderId ? ` (id ${result.folderId})` : ''} (requested for client "${client.name}") - ${result.deleted ? 'deleted' : 'did not exist'}.`
      );
    } catch (error) {
      const message = formatError(error);
      console.error(`  [CLIENT CLEANUP] ShareFile folder-delete FAILED for "${client.name}" ("${shareFileResolved}"): ${message}`);
      warnings.push(`ShareFile: could not delete the folder automatically, please remove it manually. (${message})`);
    }
  }


  // The Outlook mail folder is addressed by a per-client stored id that path edits
  // never rewrite, so it is always this client's own folder — safe to delete.
  if ((await isDelegatedConfigAvailable()) && client.outlookFolderId) {
    try {
      const accessToken = await getAccessTokenFromRefreshToken();
      await deleteMailFolder(client.outlookFolderId, accessToken, undefined);
      console.log(
        `  [CLIENT CLEANUP] Outlook mail-folder (id ${client.outlookFolderId}) for "${client.name}" deleted.`
      );
    } catch (error) {
      const message = formatError(error);
      console.error(`  [CLIENT CLEANUP] Outlook mail-folder delete FAILED for "${client.name}": ${message}`);
      warnings.push(`Outlook: could not delete the mail folder automatically, please remove it manually. (${message})`);
    }
  }

  return warnings;
};

module.exports = { deleteClientFolders };
