const sanitizeForPath = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_').trim();

const isDropboxTeamNamespaceActive = () => Boolean(process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID);

const joinFolderPath = (rootPath, clientPath) => {
  const segments = [rootPath, clientPath]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .flatMap((part) => part.split('/'))
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.join('/');
};

const resolveFolderPath = (rootPath, clientPath, isAbsolute) => {
  if (isAbsolute) {
    return String(clientPath || '')
      .trim()
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('/');
  }
  return joinFolderPath(rootPath, clientPath);
};

// Pure equivalent of dropboxService.resolveDropboxFolderPath: same normalization
// (effective-root prefixing, absolute-vs-relative, per-segment sanitize, slash
// collapsing) without any settings/DB access — the caller supplies dropboxRootPath.
// dropboxService.resolveDropboxFolderPath now delegates here so the two cannot drift.
const resolveDropboxFolderPathSync = (dropboxRootPath, clientFolderSegment, isAbsolute = false) => {
  const effectiveRootPath = isDropboxTeamNamespaceActive() ? '' : dropboxRootPath;
  const resolvedFolder = resolveFolderPath(effectiveRootPath, clientFolderSegment, isAbsolute);
  const folderSegments = resolvedFolder.split('/').map(sanitizeForPath).filter(Boolean);
  return `/${folderSegments.join('/')}`;
};

module.exports = {
  joinFolderPath,
  resolveFolderPath,
  sanitizeForPath,
  isDropboxTeamNamespaceActive,
  resolveDropboxFolderPathSync,
};
