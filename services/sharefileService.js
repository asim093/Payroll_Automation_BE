
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const OAuthCredential = require('../models/OAuthCredential');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');
const {
  PROVIDER_KEY: SHAREFILE_OAUTH_PROVIDER_KEY,
  refreshAccessToken,
} = require('./shareFileOAuthSetupService');

const getShareFileAccessTokenViaPassword = async () => {
  const { SHAREFILE_CLIENT_ID, SHAREFILE_CLIENT_SECRET, SHAREFILE_USERNAME, SHAREFILE_PASSWORD, SHAREFILE_SUBDOMAIN } =
    process.env;

  const authUrl = `https://${SHAREFILE_SUBDOMAIN}.sharefile.com/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: SHAREFILE_CLIENT_ID,
    client_secret: SHAREFILE_CLIENT_SECRET,
    username: SHAREFILE_USERNAME,
    password: SHAREFILE_PASSWORD,
  });

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`getShareFileAccessToken ERROR: status ${response.status} - ${errorBody}`);
    throw new Error(`ShareFile authentication failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return { accessToken: data.access_token, subdomain: data.subdomain, expiresIn: data.expires_in };
};

let cachedToken = null;
const EXPIRY_SAFETY_BUFFER_MS = 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

// @param options.forceRefresh - skips the cache and does a real exchange
//   even if a cached token is still valid. Needed right after a fresh
//   /oauth/sharefile/start login (e.g. the oauthSmokeTestService.js check)
//   so a stale-but-still-valid cached token from BEFORE that login doesn't
//   mask whether the just-obtained one actually works.
const getShareFileAccessToken = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return { accessToken: cachedToken.accessToken, subdomain: cachedToken.subdomain };
  }

  const { SHAREFILE_CLIENT_ID, SHAREFILE_CLIENT_SECRET, SHAREFILE_USERNAME, SHAREFILE_PASSWORD, SHAREFILE_SUBDOMAIN } =
    process.env;

  if (!SHAREFILE_CLIENT_ID || !SHAREFILE_CLIENT_SECRET || !SHAREFILE_SUBDOMAIN) {
    throw new Error('ShareFile credentials missing in .env (SHAREFILE_CLIENT_ID/SHAREFILE_CLIENT_SECRET/SHAREFILE_SUBDOMAIN).');
  }

  try {
    let result;
    const stored = await OAuthCredential.findOne({ provider: SHAREFILE_OAUTH_PROVIDER_KEY }).lean();
    if (stored?.refreshToken) {
      result = await refreshAccessToken(stored.refreshToken);
    } else if (SHAREFILE_USERNAME && SHAREFILE_PASSWORD) {
      result = await getShareFileAccessTokenViaPassword();
    } else {
      throw new Error(
        'No ShareFile authorization available — either complete the hosted login at /oauth/sharefile/start, or set SHAREFILE_USERNAME/SHAREFILE_PASSWORD in .env.'
      );
    }

    const lifetimeMs = result.expiresIn ? result.expiresIn * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    cachedToken = {
      accessToken: result.accessToken,
      subdomain: result.subdomain,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - EXPIRY_SAFETY_BUFFER_MS),
    };

    return { accessToken: result.accessToken, subdomain: result.subdomain };
  } catch (error) {
    console.error(`getShareFileAccessToken ERROR: ${formatError(error)}`);
    throw error;
  }
};

const SHAREFILE_ROOT_ALIAS = 'allshared';

const getShareFileContext = async ({ forceRefresh = false, _retriedAfter401 = false } = {}) => {
  const { accessToken, subdomain } = await getShareFileAccessToken({ forceRefresh });
  const apiBase = `https://${subdomain}.sf-api.com/sf/v3`;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  try {
    const rootResponse = await fetch(`${apiBase}/Items(${SHAREFILE_ROOT_ALIAS})`, { headers: authHeaders });

    if (rootResponse.status === 401 && !_retriedAfter401) {
      console.warn('getShareFileContext: cached token was rejected (401) - forcing a fresh token exchange and retrying once.');
      return getShareFileContext({ forceRefresh: true, _retriedAfter401: true });
    }

    if (!rootResponse.ok) {
      const errorBody = await rootResponse.text();
      throw new Error(`Could not resolve root folder (${rootResponse.status}): ${errorBody}`);
    }
    const root = await rootResponse.json();

    return { apiBase, authHeaders, rootId: root.Id };
  } catch (error) {

    console.error(`getShareFileContext ERROR (resolving root): ${formatError(error)}`);
    throw error;
  }
};

const isFileItem = (item) =>
  item['odata.type'] ? item['odata.type'].includes('.File') : typeof item.Id === 'string' && item.Id.startsWith('fi');

const ensureShareFileFolderExists = async (fullPath) => {
  const segments = fullPath
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  try {
    const { apiBase, authHeaders, rootId } = await getShareFileContext();
    let currentId = rootId;
    let anyCreated = false;

    for (const segment of segments) {
      const childrenResponse = await fetch(`${apiBase}/Items(${currentId})/Children`, { headers: authHeaders });
      if (!childrenResponse.ok) {
        const errorBody = await childrenResponse.text();
        throw new Error(`Could not list children while walking to "${fullPath}" (${childrenResponse.status}): ${errorBody}`);
      }
      const childrenData = await childrenResponse.json();
      const match = (childrenData.value || []).find(
        (item) => !isFileItem(item) && (item.Name || '').toLowerCase() === segment.toLowerCase()
      );

      if (match) {
        currentId = match.Id;
        continue;
      }

      const createResponse = await fetch(`${apiBase}/Items(${currentId})/Folder`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Name: segment }),
      });
      if (!createResponse.ok) {
        const errorBody = await createResponse.text();
        throw new Error(`Could not create folder "${segment}" under "${fullPath}" (${createResponse.status}): ${errorBody}`);
      }
      const created = await createResponse.json();
      currentId = created.Id;
      anyCreated = true;
      console.log(`  [SHAREFILE] Created folder segment "${segment}" (part of "${fullPath}").`);
    }

    return { created: anyCreated, folderId: currentId };
  } catch (error) {
    console.error(`ensureShareFileFolderExists ERROR ("${fullPath}"): ${formatError(error)}`);
    throw error;
  }
};

const listFilesInShareFileFolder = async (clientFolderSegment) => {
  const { shareFileRootPath } = await getSettings();
  const folderPath = joinFolderPath(shareFileRootPath, clientFolderSegment);

  try {
    const { apiBase, authHeaders, rootId } = await getShareFileContext();

    const folderByPathUrl = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(folderPath)}`;
    const folderResponse = await fetch(folderByPathUrl, { headers: authHeaders });
    if (!folderResponse.ok) {
      const errorBody = await folderResponse.text();
      throw new Error(`ShareFile folder not found for "${folderPath}" (${folderResponse.status}): ${errorBody}`);
    }
    const folder = await folderResponse.json();

    const childrenResponse = await fetch(`${apiBase}/Items(${folder.Id})/Children`, { headers: authHeaders });
    if (!childrenResponse.ok) {
      const errorBody = await childrenResponse.text();
      throw new Error(`Could not list files in "${folderPath}" (${childrenResponse.status}): ${errorBody}`);
    }
    const childrenData = await childrenResponse.json();
    return (childrenData.value || []).filter(isFileItem);
  } catch (error) {

    console.error(`listFilesInShareFileFolder ERROR ("${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

const downloadFileContentById = async (fileId) => {
  try {
    const { apiBase, authHeaders } = await getShareFileContext();

    const downloadUrl = `${apiBase}/Items(${fileId})/Download`;
    const downloadResponse = await fetch(downloadUrl, { headers: authHeaders });
    if (!downloadResponse.ok) {
      const errorBody = await downloadResponse.text();
      throw new Error(`Download failed (${downloadResponse.status}): ${errorBody}`);
    }

    const contentType = downloadResponse.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const downloadSpec = await downloadResponse.json();
      const fileResponse = await fetch(downloadSpec.DownloadUrl);
      if (!fileResponse.ok) {
        throw new Error(`Download from DownloadUrl failed (${fileResponse.status})`);
      }
      return Buffer.from(await fileResponse.arrayBuffer());
    }
    return Buffer.from(await downloadResponse.arrayBuffer());
  } catch (error) {
    console.error(`downloadFileContentById ERROR ("${fileId}"): ${formatError(error)}`);
    throw error;
  }
};

const getLatestFileInShareFileFolder = async (clientFolderSegment) => {
  try {
    const files = await listFilesInShareFileFolder(clientFolderSegment);
    if (files.length === 0) {
      throw new Error(`No files found in ShareFile folder for "${clientFolderSegment}"`);
    }

    const getTimestamp = (item) => new Date(item.CreationDate || item.ProgenyEditDate || 0).getTime();
    files.sort((a, b) => getTimestamp(b) - getTimestamp(a));

    const latest = files[0];
    return {
      fileName: latest.Name || latest.FileName,
      fileId: latest.Id,
      uploadedAt: latest.CreationDate || latest.ProgenyEditDate,
    };
  } catch (error) {
    console.error(
      `getLatestFileInShareFileFolder ERROR: could not find latest file for "${clientFolderSegment}" — ${formatError(error)}`
    );
    throw error;
  }
};

const fetchFileFromShareFile = async (clientFolderSegment, fileName) => {
  try {
    let fileId;
    let resolvedFileName;

    if (fileName) {
      resolvedFileName = fileName;
      const { apiBase, authHeaders, rootId } = await getShareFileContext();
      const { shareFileRootPath } = await getSettings();
      const itemPath = `${joinFolderPath(shareFileRootPath, clientFolderSegment)}/${fileName}`;
      const byPathUrl = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(itemPath)}`;
      const itemResponse = await fetch(byPathUrl, { headers: authHeaders });
      if (!itemResponse.ok) {
        const errorBody = await itemResponse.text();
        throw new Error(`Item lookup failed (${itemResponse.status}): ${errorBody}`);
      }
      const item = await itemResponse.json();
      fileId = item.Id;
    } else {
      const latest = await getLatestFileInShareFileFolder(clientFolderSegment);
      fileId = latest.fileId;
      resolvedFileName = latest.fileName;
      console.log(
        `  [SHAREFILE] Auto-detected latest file: ${latest.fileName}, uploaded on ${latest.uploadedAt}`
      );
    }

    const content = await downloadFileContentById(fileId);
    return { content, fileName: resolvedFileName };
  } catch (error) {
    console.error(
      `fetchFileFromShareFile ERROR: could not fetch file for "${clientFolderSegment}"${
        fileName ? ` ("${fileName}")` : ' (auto-detect)'
      } — ${formatError(error)}`
    );
    throw error;
  }
};

const scanShareFileForNewFiles = async () => {
  const activeClients = await Client.find({ status: 'active' });
  const newFiles = [];

  for (const client of activeClients) {
    const shareFileFolderSegment = client.shareFilePath || client.name;
    let files;
    try {
      files = await listFilesInShareFileFolder(shareFileFolderSegment);
    } catch (error) {
      console.warn(`  [SHAREFILE SCAN] Skipping "${client.name}" - ${formatError(error)}`);
      continue;
    }

    for (const file of files) {

      const alreadyProcessed = await FileLog.findOne({ sourceFileId: file.Id, clientId: client._id });
      if (alreadyProcessed) continue;

      try {
        const content = await downloadFileContentById(file.Id);
        newFiles.push({
          clientId: client._id,
          clientName: client.name,
          dropboxFolderSegment: client.dropboxPath || client.name,
          fileName: file.Name || file.FileName,
          fileId: file.Id,
          content,
        });
      } catch (error) {
        console.error(
          `  [SHAREFILE SCAN] Could not download "${file.Name}" for "${client.name}": ${formatError(error)}`
        );
      }
    }
  }

  return newFiles;
};

const recordUnmatchedItem = async (item, path, isEmpty = false) => {
  const isFile = isFileItem(item);

  if (!isFile && isEmpty) {
    await UnmatchedShareFileItem.deleteOne({ itemId: item.Id, status: 'unresolved' });
    return false;
  }

  const existing = await UnmatchedShareFileItem.findOne({ itemId: item.Id });
  if (existing) {
    if (existing.status === 'unresolved') {
      existing.lastSeenAt = new Date();
      existing.isEmpty = isEmpty;
      await existing.save();
    }
    return false;
  }

  await UnmatchedShareFileItem.create({
    itemId: item.Id,
    itemType: isFile ? 'file' : 'folder',
    name: item.Name || item.FileName || '(unnamed)',
    path,
    isEmpty,
    discoveredAt: new Date(),
    lastSeenAt: new Date(),
    status: 'unresolved',
  });
  console.log(`  [SHAREFILE ORPHAN SCAN] New unmatched ${isFile ? 'file' : 'folder'}: "${path}"${isEmpty ? ' (empty)' : ''}`);
  return true;
};

const listChildren = async (folderId, apiBase, authHeaders) => {
  const response = await fetch(`${apiBase}/Items(${folderId})/Children`, { headers: authHeaders });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Could not list children of folder ${folderId} (${response.status}): ${errorBody}`);
  }
  const data = await response.json();
  return data.value || [];
};

const scanClientPathForMismatches = async (client, shareFileRootPath, apiBase, authHeaders, accountRootId) => {
  const expectedSegments = (client.shareFilePath || client.name)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (expectedSegments.length < 2) return 0;

  let currentId = accountRootId;
  let currentPath = '';
  if (shareFileRootPath) {
    try {
      const rootResponse = await fetch(`${apiBase}/Items(${accountRootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`, {
        headers: authHeaders,
      });
      if (!rootResponse.ok) return 0;
      const rootFolder = await rootResponse.json();
      currentId = rootFolder.Id;
      currentPath = shareFileRootPath;
    } catch (error) {
      console.warn(`  [SHAREFILE PATH-MISMATCH SCAN] Could not resolve root path "${shareFileRootPath}" - ${formatError(error)}`);
      return 0;
    }
  }

  let newOrphans = 0;

  for (let level = 0; level < expectedSegments.length; level += 1) {
    const expectedName = expectedSegments[level];
    let children;
    try {
      children = await listChildren(currentId, apiBase, authHeaders);
    } catch (error) {
      console.warn(`  [SHAREFILE PATH-MISMATCH SCAN] Could not list "${currentPath}" for "${client.name}" - ${formatError(error)}`);
      return newOrphans;
    }

    if (level > 0) {
      for (const child of children) {
        const name = child.Name || child.FileName || '(unnamed)';
        if (!isFileItem(child) && name.trim().toLowerCase() === expectedName.trim().toLowerCase()) {
          continue;
        }
        const childIsFile = isFileItem(child);
        const childIsEmpty = childIsFile ? false : (await listChildren(child.Id, apiBase, authHeaders)).length === 0;
        const created = await recordUnmatchedItem(child, `${currentPath}/${name}`, childIsEmpty);
        if (created) newOrphans++;
      }
    }

    const match = children.find(
      (child) => !isFileItem(child) && (child.Name || '').trim().toLowerCase() === expectedName.trim().toLowerCase()
    );
    if (!match) return newOrphans;

    currentId = match.Id;
    currentPath = `${currentPath}/${expectedName}`;
  }

  return newOrphans;
};

const scanShareFileRootForUnmatchedItems = async () => {
  const { shareFileRootPath } = await getSettings();
  const { apiBase, authHeaders, rootId: accountRootId } = await getShareFileContext();

  let rootId = accountRootId;
  if (shareFileRootPath) {
    const rootResponse = await fetch(`${apiBase}/Items(${accountRootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`, {
      headers: authHeaders,
    });
    if (!rootResponse.ok) {

      console.log(`  [SHAREFILE ORPHAN SCAN] Root path "${shareFileRootPath}" not found - skipping.`);
      return { scanned: 0, newOrphans: 0 };
    }
    const rootFolder = await rootResponse.json();
    rootId = rootFolder.Id;
  }

  const children = await listChildren(rootId, apiBase, authHeaders);

  const clients = await Client.find();

  const folderNameToClient = new Map();
  clients.forEach((client) => {
    const topSegment = (client.shareFilePath || client.name).split('/')[0].trim().toLowerCase();
    if (!folderNameToClient.has(topSegment)) {
      folderNameToClient.set(topSegment, client);
    }
  });

  let newOrphans = 0;
  let autoResolved = 0;
  for (const item of children) {
    const isFile = isFileItem(item);
    const name = item.Name || item.FileName || '(unnamed)';
    const matchedClient = !isFile ? folderNameToClient.get(name.trim().toLowerCase()) : undefined;

    if (matchedClient) {
      const result = await UnmatchedShareFileItem.updateOne(
        { itemId: item.Id, status: 'unresolved' },
        { status: 'resolved', resolvedClientId: matchedClient._id, resolvedAt: new Date() }
      );
      autoResolved += result.modifiedCount || 0;
      continue;
    }

    const path = shareFileRootPath ? `${shareFileRootPath}/${name}` : name;
    const isEmpty = isFile ? false : (await listChildren(item.Id, apiBase, authHeaders)).length === 0;
    const created = await recordUnmatchedItem(item, path, isEmpty);
    if (created) newOrphans++;
  }

  for (const client of clients) {
    newOrphans += await scanClientPathForMismatches(client, shareFileRootPath, apiBase, authHeaders, accountRootId);
  }

  return { scanned: children.length, newOrphans, autoResolved };
};

const resolveShareFileFolderId = async (fullPath) => {
  const segments = fullPath
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  const { apiBase, authHeaders, rootId } = await getShareFileContext();
  let currentId = rootId;

  for (const segment of segments) {
    const childrenResponse = await fetch(`${apiBase}/Items(${currentId})/Children`, { headers: authHeaders });
    if (!childrenResponse.ok) {
      const errorBody = await childrenResponse.text();
      throw new Error(`Could not list children while walking to "${fullPath}" (${childrenResponse.status}): ${errorBody}`);
    }
    const childrenData = await childrenResponse.json();
    const match = (childrenData.value || []).find(
      (item) => !isFileItem(item) && (item.Name || '').toLowerCase() === segment.toLowerCase()
    );
    if (!match) return null;
    currentId = match.Id;
  }

  return currentId;
};

const deleteShareFileFolder = async (fullPath) => {
  try {
    const { apiBase, authHeaders } = await getShareFileContext();
    const folderId = await resolveShareFileFolderId(fullPath);
    if (!folderId) {
      return { deleted: false };
    }

    const deleteResponse = await fetch(`${apiBase}/Items(${folderId})`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const errorBody = await deleteResponse.text();
      throw new Error(`Could not delete folder "${fullPath}" (${deleteResponse.status}): ${errorBody}`);
    }

    console.log(`  [SHAREFILE] Deleted folder "${fullPath}".`);
    return { deleted: true };
  } catch (error) {
    console.error(`deleteShareFileFolder ERROR ("${fullPath}"): ${formatError(error)}`);
    throw error;
  }
};

const deleteShareFileItemById = async (itemId) => {
  const { apiBase, authHeaders } = await getShareFileContext();
  const deleteResponse = await fetch(`${apiBase}/Items(${itemId})`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const errorBody = await deleteResponse.text();
    throw new Error(`Could not delete item ${itemId} (${deleteResponse.status}): ${errorBody}`);
  }
  console.log(`  [SHAREFILE] Deleted item ${itemId}.`);
  return { deleted: true };
};

module.exports = {
  getShareFileAccessToken,
  getShareFileContext,
  getLatestFileInShareFileFolder,
  fetchFileFromShareFile,
  scanShareFileForNewFiles,
  ensureShareFileFolderExists,
  deleteShareFileFolder,
  deleteShareFileItemById,
  scanShareFileRootForUnmatchedItems,
  downloadFileContentById,
};
