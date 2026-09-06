const { resolveFolderPath, resolveDropboxFolderPathSync } = require('./folderPath');
const { getSettings } = require('../services/settingsService');

// Canonical, comparable identifier for where a client's Dropbox folder actually
// resolves to. Two clients whose paths differ only by formatting (absolute vs
// relative, root prefix, trailing/duplicate slashes, letter case) produce the
// same key. Spaces vs hyphens are intentionally NOT normalized — those are
// genuinely different folders.
const dropboxFolderKey = (client, dropboxRootPath) =>
  resolveDropboxFolderPathSync(
    dropboxRootPath,
    client.dropboxPath || client.name,
    Boolean(client.dropboxPathIsAbsolute)
  ).toLowerCase();

// Canonical, comparable identifier for a client's ShareFile folder location.
const shareFileFolderKey = (client, shareFileRootPath) =>
  resolveFolderPath(
    shareFileRootPath,
    client.shareFilePath || client.name,
    Boolean(client.shareFilePathIsAbsolute)
  ).toLowerCase();

const isEmptyKey = (key) => !key || key === '/' || key === '';

// Returns the other clients that resolve to the same Dropbox and/or ShareFile
// folder as `subject`. `others` may include `subject` itself; it is excluded by _id.
const findClientsSharingFolders = (subject, others, { dropboxRootPath, shareFileRootPath }) => {
  const subjectDropbox = dropboxFolderKey(subject, dropboxRootPath);
  const subjectShareFile = shareFileFolderKey(subject, shareFileRootPath);
  const dropbox = [];
  const shareFile = [];

  for (const other of others) {
    if (subject._id && other._id && String(other._id) === String(subject._id)) continue;
    if (!isEmptyKey(subjectDropbox) && dropboxFolderKey(other, dropboxRootPath) === subjectDropbox) {
      dropbox.push(other);
    }
    if (!isEmptyKey(subjectShareFile) && shareFileFolderKey(other, shareFileRootPath) === subjectShareFile) {
      shareFile.push(other);
    }
  }

  return { dropbox, shareFile };
};

const loadFolderIdentitySettings = async () => {
  const { dropboxRootPath, shareFileRootPath } = await getSettings();
  return { dropboxRootPath: dropboxRootPath || '', shareFileRootPath: shareFileRootPath || '' };
};

module.exports = {
  dropboxFolderKey,
  shareFileFolderKey,
  findClientsSharingFolders,
  loadFolderIdentitySettings,
};
