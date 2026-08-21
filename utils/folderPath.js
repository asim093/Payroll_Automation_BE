const joinFolderPath = (rootPath, clientPath) => {
  const segments = [rootPath, clientPath]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .flatMap((part) => part.split('/'))
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.join('/');
};

module.exports = { joinFolderPath };
