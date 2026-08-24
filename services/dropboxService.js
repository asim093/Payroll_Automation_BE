const { Dropbox } = require('dropbox');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');
const Client = require('../models/Client');
const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');
const OAuthCredential = require('../models/OAuthCredential');
const {
  PROVIDER_KEY: DROPBOX_OAUTH_PROVIDER_KEY,
  refreshAccessToken,
} = require('./dropboxOAuthSetupService');

const sanitizeForPath = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_').trim();

const getDropboxAccessTokenViaEnv = async () => {
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  if (!refreshToken) {
    throw new Error(
      'No Dropbox authorization available — either complete the hosted login at /oauth/dropbox/start, or run getDropboxRefreshToken.js and set DROPBOX_REFRESH_TOKEN in .env.'
    );
  }
  if (!appKey || !appSecret) {
    throw new Error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET is not set in .env.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`getDropboxAccessToken ERROR: status ${response.status} - ${errorBody}`);
    throw new Error(`Dropbox token refresh failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
};

let cachedToken = null;
const EXPIRY_SAFETY_BUFFER_MS = 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

// @param options.forceRefresh - see sharefileService.js's identical option
//   on getShareFileAccessToken() - same reasoning (verifying a just-obtained
//   token right after a fresh /oauth/dropbox/start login).
const getDropboxAccessToken = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  try {
    const stored = await OAuthCredential.findOne({ provider: DROPBOX_OAUTH_PROVIDER_KEY }).lean();
    const result = stored?.refreshToken
      ? await refreshAccessToken(stored.refreshToken)
      : await getDropboxAccessTokenViaEnv();

    const lifetimeMs = result.expiresIn ? result.expiresIn * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    cachedToken = {
      accessToken: result.accessToken,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - EXPIRY_SAFETY_BUFFER_MS),
    };

    return result.accessToken;
  } catch (error) {
    console.error(`getDropboxAccessToken ERROR: ${formatError(error)}`);
    throw error;
  }
};

const resolveDropboxFolderPath = async (clientFolderSegment) => {
  const { dropboxRootPath } = await getSettings();
  const resolvedFolder = joinFolderPath(dropboxRootPath, clientFolderSegment);

  const folderSegments = resolvedFolder.split('/').map(sanitizeForPath).filter(Boolean);
  return `/${folderSegments.join('/')}`;
};

const uploadFileToDropbox = async (clientFolderSegment, fileName, contentBuffer, referenceDate) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });

  const folderPath = await resolveDropboxFolderPath(clientFolderSegment);
  const uniqueName = generateUniqueFilename(fileName, referenceDate);
  const safeFileName = sanitizeForPath(uniqueName);
  const dropboxPath = `${folderPath}/${safeFileName}`;

  try {
    const response = await dbx.filesUpload({
      path: dropboxPath,
      contents: contentBuffer,
      mode: { '.tag': 'overwrite' },
    });
    return response.result.path_display;
  } catch (error) {
    const status = error.status ?? 'n/a';
    const message = error?.error?.error_summary || formatError(error) || 'Unknown error';
    console.error(
      `uploadFileToDropbox ERROR: could not upload "${fileName}" for "${clientFolderSegment}" — status: ${status} — ${message}`
    );
    throw error;
  }
};

const ensureDropboxFolderExists = async (clientFolderSegment) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment);

  try {
    await dbx.filesGetMetadata({ path: folderPath });
    return { created: false, path: folderPath };
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (!errorSummary.startsWith('path/not_found')) {
      console.error(`ensureDropboxFolderExists ERROR (checking "${folderPath}"): ${formatError(error)}`);
      throw error;
    }
  }

  try {
    await dbx.filesCreateFolderV2({ path: folderPath });
    console.log(`  [DROPBOX] Created folder "${folderPath}".`);
    return { created: true, path: folderPath };
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path/conflict')) {
      return { created: false, path: folderPath };
    }
    console.error(`ensureDropboxFolderExists ERROR (creating "${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

const deleteDropboxFolder = async (clientFolderSegment) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment);

  try {
    await dbx.filesDeleteV2({ path: folderPath });
    console.log(`  [DROPBOX] Deleted folder "${folderPath}".`);
    return { deleted: true, path: folderPath };
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path_lookup/not_found')) {
      return { deleted: false, path: folderPath };
    }
    console.error(`deleteDropboxFolder ERROR (deleting "${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

const scanDropboxRootForUnmatchedItems = async () => {
  const { dropboxRootPath } = await getSettings();
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });

  const rootPath = dropboxRootPath ? `/${dropboxRootPath.replace(/^\/+/, '')}` : '';

  let children;
  try {
    const response = await dbx.filesListFolder({ path: rootPath });
    children = response.result.entries;
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path/not_found')) {
      console.log(`  [DROPBOX ORPHAN SCAN] Root path "${dropboxRootPath}" not found - skipping.`);
      return { scanned: 0, newOrphans: 0, autoResolved: 0 };
    }
    console.error(`scanDropboxRootForUnmatchedItems ERROR (listing root): ${formatError(error)}`);
    throw error;
  }

  const clients = await Client.find();
  const folderNameToClient = new Map();
  clients.forEach((client) => {
    const topSegment = (client.dropboxPath || client.name).split('/')[0].trim().toLowerCase();
    if (!folderNameToClient.has(topSegment)) {
      folderNameToClient.set(topSegment, client);
    }
  });

  let newOrphans = 0;
  let autoResolved = 0;

  for (const entry of children) {
    const isFolder = entry['.tag'] === 'folder';
    const name = entry.name;
    const matchedClient = isFolder ? folderNameToClient.get(name.trim().toLowerCase()) : undefined;

    if (matchedClient) {
      const result = await UnmatchedDropboxItem.updateOne(
        { itemId: entry.id, status: 'unresolved' },
        { status: 'resolved', resolvedClientId: matchedClient._id, resolvedAt: new Date() }
      );
      autoResolved += result.modifiedCount || 0;
      continue;
    }

    let isEmpty = false;
    if (isFolder) {
      const childResponse = await dbx.filesListFolder({ path: entry.path_lower });
      isEmpty = childResponse.result.entries.length === 0;
    }

    const existing = await UnmatchedDropboxItem.findOne({ itemId: entry.id });
    if (existing) {
      if (existing.status === 'unresolved') {
        existing.lastSeenAt = new Date();
        existing.isEmpty = isEmpty;
        await existing.save();
      }
      continue;
    }

    await UnmatchedDropboxItem.create({
      itemId: entry.id,
      itemType: isFolder ? 'folder' : 'file',
      name,
      path: entry.path_display,
      isEmpty,
      discoveredAt: new Date(),
      lastSeenAt: new Date(),
      status: 'unresolved',
    });
    console.log(
      `  [DROPBOX ORPHAN SCAN] New unmatched ${isFolder ? 'folder' : 'file'}: "${entry.path_display}"${isEmpty ? ' (empty)' : ''}`
    );
    newOrphans++;
  }

  return { scanned: children.length, newOrphans, autoResolved };
};

const deleteDropboxItemByPath = async (path) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });
  try {
    await dbx.filesDeleteV2({ path });
    console.log(`  [DROPBOX] Deleted item "${path}".`);
    return { deleted: true };
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path_lookup/not_found')) {
      return { deleted: false };
    }
    console.error(`deleteDropboxItemByPath ERROR ("${path}"): ${formatError(error)}`);
    throw error;
  }
};

const moveDropboxItemToClientFolder = async (fromPath, clientFolderSegment, fileName) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });
  const destinationFolder = await resolveDropboxFolderPath(clientFolderSegment);
  const toPath = `${destinationFolder}/${sanitizeForPath(fileName)}`;

  const response = await dbx.filesMoveV2({ from_path: fromPath, to_path: toPath, autorename: true });
  console.log(`  [DROPBOX] Moved "${fromPath}" -> "${response.result.metadata.path_display}".`);
  return response.result.metadata.path_display;
};

module.exports = {
  uploadFileToDropbox,
  ensureDropboxFolderExists,
  deleteDropboxFolder,
  scanDropboxRootForUnmatchedItems,
  deleteDropboxItemByPath,
  moveDropboxItemToClientFolder,
  getDropboxAccessToken,
};
