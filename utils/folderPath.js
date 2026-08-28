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

module.exports = { joinFolderPath, resolveFolderPath };
