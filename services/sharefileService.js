
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const OAuthCredential = require('../models/OAuthCredential');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { resolveFolderPath } = require('../utils/folderPath');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SF_FETCH_TIMEOUT_MS = 30 * 1000;
const SF_FETCH_MAX_ATTEMPTS = 4;
const SF_RETRY_BASE_DELAY_MS = 500;

const isTransientStatus = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

const sfFetch = async (url, options = {}, label = 'ShareFile request', { onUnauthorized } = {}) => {
  let lastError;
  let headers = options.headers;
  let refreshedAuth = false;
  for (let attempt = 1; attempt <= SF_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SF_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 401 && onUnauthorized && !refreshedAuth) {
        refreshedAuth = true;
        console.warn(`${label}: HTTP 401 - forcing a fresh ShareFile token and retrying once.`);
        try {
          headers = { ...headers, ...(await onUnauthorized()) };
          await sleep(SF_RETRY_BASE_DELAY_MS);
          continue;
        } catch (refreshError) {
          console.error(`${label}: token refresh failed - ${refreshError.message}`);
          return response;
        }
      }

      if (isTransientStatus(response.status) && attempt < SF_FETCH_MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30 * 1000)
            : SF_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`${label}: HTTP ${response.status} - retrying in ${delayMs}ms (attempt ${attempt}/${SF_FETCH_MAX_ATTEMPTS}).`);
        await sleep(delayMs);
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt >= SF_FETCH_MAX_ATTEMPTS) break;
      const delayMs = SF_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const cause = error.name === 'AbortError' ? `timed out after ${SF_FETCH_TIMEOUT_MS}ms` : error.message;
      console.warn(`${label}: ${cause} - retrying in ${delayMs}ms (attempt ${attempt}/${SF_FETCH_MAX_ATTEMPTS}).`);
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`${label} failed after ${SF_FETCH_MAX_ATTEMPTS} attempts`);
};

const CHILDREN_PAGE_SIZE = 1000;

const parseShareFileDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const shareFileItemCreatedAt = (item) => {
  const isFolder = !isFileItem(item);
  if (isFolder) {
    return parseShareFileDate(item.CreationDate || item.ClientCreatedDate);
  }
  return parseShareFileDate(
    item.CreationDate || item.ClientCreatedDate || item.ProgenyEditDate || item.ClientModifiedDate
  );
};

const listAllChildren = async (folderId, apiBase, authHeaders, label = 'folder', { onUnauthorized } = {}) => {
  const collected = [];
  let skip = 0;
  for (;;) {
    const url = `${apiBase}/Items(${folderId})/Children?$top=${CHILDREN_PAGE_SIZE}&$skip=${skip}`;
    const response = await sfFetch(url, { headers: authHeaders }, `List children of ${label}`, { onUnauthorized });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Could not list children of ${label} (${response.status}): ${errorBody}`);
    }
    const data = await response.json();
    const page = data.value || [];
    collected.push(...page);

    const total = Number(data['odata.count']);
    if (page.length < CHILDREN_PAGE_SIZE) break;
    if (Number.isFinite(total) && collected.length >= total) break;
    skip += CHILDREN_PAGE_SIZE;
  }
  return collected;
};

const isTokenRotationRaceError = (error) =>
  error?.code === 'invalid_grant' || /invalid or revoked/i.test(error?.message || '');

const MAX_ROTATION_RETRY_ATTEMPTS = 3;
const ROTATION_RETRY_DELAY_MS = 400;

const refreshShareFileTokenWithRotationRetry = async (initialRefreshToken) => {
  let tokenToTry = initialRefreshToken;
  for (let attempt = 1; attempt <= MAX_ROTATION_RETRY_ATTEMPTS; attempt++) {
    try {
      return await refreshAccessToken(tokenToTry);
    } catch (error) {
      const isLastAttempt = attempt === MAX_ROTATION_RETRY_ATTEMPTS;
      if (!isTokenRotationRaceError(error) || isLastAttempt) {
        throw error;
      }
      console.warn(
        `getShareFileAccessToken: refresh token was already rotated by another process (attempt ${attempt}/${MAX_ROTATION_RETRY_ATTEMPTS}) — re-fetching the latest stored token and retrying.`
      );
      await sleep(ROTATION_RETRY_DELAY_MS);
      const latest = await OAuthCredential.findOne({ provider: SHAREFILE_OAUTH_PROVIDER_KEY }).lean();
      if (!latest?.refreshToken) throw error;
      tokenToTry = latest.refreshToken;
    }
  }
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
      result = await refreshShareFileTokenWithRotationRetry(stored.refreshToken);
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

const listFilesInShareFileFolder = async (clientFolderSegment, isAbsolute = false) => {
  const { shareFileRootPath } = await getSettings();
  const folderPath = resolveFolderPath(shareFileRootPath, clientFolderSegment, isAbsolute);

  try {
    const { apiBase, authHeaders, rootId } = await getShareFileContext();

    const folderByPathUrl = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(folderPath)}`;
    const folderResponse = await sfFetch(folderByPathUrl, { headers: authHeaders }, `Resolve "${folderPath}"`);
    if (!folderResponse.ok) {
      const errorBody = await folderResponse.text();
      throw new Error(`ShareFile folder not found for "${folderPath}" (${folderResponse.status}): ${errorBody}`);
    }
    const folder = await folderResponse.json();

    const children = await listAllChildren(folder.Id, apiBase, authHeaders, `"${folderPath}"`);
    return children.filter(isFileItem);
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

const getLatestFileInShareFileFolder = async (clientFolderSegment, isAbsolute = false) => {
  try {
    const files = await listFilesInShareFileFolder(clientFolderSegment, isAbsolute);
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

const findLatestLogiFormsCsvInShareFile = async (folderPath) => {
  const cleanPath = String(folderPath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');

  if (!cleanPath) {
    throw new Error('LogiForms ShareFile folder path is empty.');
  }

  try {
    const { apiBase, authHeaders, rootId } = await getShareFileContext();

    const folderResponse = await fetch(
      `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(cleanPath)}`,
      { headers: authHeaders }
    );
    if (!folderResponse.ok) {
      const errorBody = await folderResponse.text();
      throw new Error(`ShareFile folder not found for "${cleanPath}" (${folderResponse.status}): ${errorBody}`);
    }
    const folder = await folderResponse.json();

    const childrenResponse = await fetch(`${apiBase}/Items(${folder.Id})/Children`, { headers: authHeaders });
    if (!childrenResponse.ok) {
      const errorBody = await childrenResponse.text();
      throw new Error(`Could not list files in "${cleanPath}" (${childrenResponse.status}): ${errorBody}`);
    }
    const childrenData = await childrenResponse.json();

    const csvFiles = (childrenData.value || [])
      .filter(isFileItem)
      .filter((item) => (item.Name || item.FileName || '').toLowerCase().endsWith('.csv'));

    if (csvFiles.length === 0) {
      return null;
    }

    const getTimestamp = (item) =>
      new Date(item.CreationDate || item.ClientModifiedDate || item.ProgenyEditDate || 0).getTime();
    csvFiles.sort((a, b) => getTimestamp(b) - getTimestamp(a));

    const latest = csvFiles[0];
    return {
      fileName: latest.Name || latest.FileName,
      fileId: latest.Id,
      modifiedAt: latest.CreationDate || latest.ClientModifiedDate || latest.ProgenyEditDate || null,
    };
  } catch (error) {
    console.error(`findLatestLogiFormsCsvInShareFile ERROR ("${cleanPath}"): ${formatError(error)}`);
    throw error;
  }
};

const fetchFileFromShareFile = async (clientFolderSegment, fileName, isAbsolute = false) => {
  try {
    let fileId;
    let resolvedFileName;

    if (fileName) {
      resolvedFileName = fileName;
      const { apiBase, authHeaders, rootId } = await getShareFileContext();
      const { shareFileRootPath } = await getSettings();
      const itemPath = `${resolveFolderPath(shareFileRootPath, clientFolderSegment, isAbsolute)}/${fileName}`;
      const byPathUrl = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(itemPath)}`;
      const itemResponse = await fetch(byPathUrl, { headers: authHeaders });
      if (!itemResponse.ok) {
        const errorBody = await itemResponse.text();
        throw new Error(`Item lookup failed (${itemResponse.status}): ${errorBody}`);
      }
      const item = await itemResponse.json();
      fileId = item.Id;
    } else {
      const latest = await getLatestFileInShareFileFolder(clientFolderSegment, isAbsolute);
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
  const treeScan = await scanShareFileClientsTree();
  return treeScan.newFiles;
};

const recordUnmatchedFile = async (fileItem, path) => {
  const sourceCreatedAt = shareFileItemCreatedAt(fileItem);

  const existing = await UnmatchedShareFileItem.findOne({ itemId: fileItem.Id });
  if (existing) {
    if (existing.status === 'unresolved') {
      existing.lastSeenAt = new Date();
      if (sourceCreatedAt) {
        if (!existing.sourceCreatedAt) existing.sourceCreatedAt = sourceCreatedAt;
        if (existing.discoveredAt > sourceCreatedAt) existing.discoveredAt = sourceCreatedAt;
      }
      await existing.save();
    }
    return false;
  }

  await UnmatchedShareFileItem.create({
    itemId: fileItem.Id,
    name: fileItem.Name || fileItem.FileName || '(unnamed)',
    path,
    discoveredAt: sourceCreatedAt || new Date(),
    sourceCreatedAt: sourceCreatedAt || undefined,
    lastSeenAt: new Date(),
    status: 'unresolved',
  });
  console.log(`  [SHAREFILE SCAN] New unmatched file: "${path}"`);
  return true;
};

const listChildren = (folderId, apiBase, authHeaders) =>
  listAllChildren(folderId, apiBase, authHeaders, `folder ${folderId}`);

const scanClientPathForMismatches = async (client, shareFileRootPath, apiBase, authHeaders, accountRootId) => {
  if (client.shareFilePathIsAbsolute) return 0;

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
        if (!isFileItem(child)) continue;
        const name = child.Name || child.FileName || '(unnamed)';
        const created = await recordUnmatchedFile(child, `${currentPath}/${name}`);
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

const DEFAULT_SHAREFILE_INGEST_SINCE = '2026-08-26T00:00:00.000Z';
const getShareFileIngestSince = () => {
  const parsed = new Date(process.env.SHAREFILE_INGEST_SINCE_DATE || DEFAULT_SHAREFILE_INGEST_SINCE);
  return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_SHAREFILE_INGEST_SINCE) : parsed;
};
const INTER_FOLDER_DELAY_MS = 60;
const SUBFOLDER_SCAN_MAX_DEPTH = 10;
const MAX_FILES_PER_CLIENT_FOLDER = 8000;

const isBeforeCutoff = (file, since) => {
  const created = shareFileItemCreatedAt(file);
  return created ? created < since : false;
};

const collectFilesInTree = async (folderId, folderPath, apiBase, authHeaders, options) => {
  const { onUnauthorized, since, state, depth = 0 } = options;
  const visited = options.visited || new Set();

  if (visited.has(folderId)) return;
  visited.add(folderId);

  const children = await listAllChildren(folderId, apiBase, authHeaders, `"${folderPath}"`, { onUnauthorized });

  for (const child of children) {
    if (state.files.length >= MAX_FILES_PER_CLIENT_FOLDER) {
      state.capped = true;
      return;
    }

    if (isFileItem(child)) {
      const childName = child.Name || child.FileName || '(unnamed)';
      state.files.push({ item: child, path: `${folderPath}/${childName}` });
      continue;
    }

    if (depth >= SUBFOLDER_SCAN_MAX_DEPTH) {
      state.depthLimited = true;
      console.warn(`  [SHAREFILE SCAN] Max depth ${SUBFOLDER_SCAN_MAX_DEPTH} reached at "${folderPath}" - deeper subfolders not scanned this cycle.`);
      continue;
    }

    const progenyEdit = parseShareFileDate(child.ProgenyEditDate);
    if (progenyEdit && since && progenyEdit < since) {
      continue;
    }

    const childName = child.Name || '(unnamed)';
    await sleep(15);
    await collectFilesInTree(child.Id, `${folderPath}/${childName}`, apiBase, authHeaders, {
      ...options,
      visited,
      depth: depth + 1,
    });
  }
};

const buildActiveClientFolderMap = async () => {
  const activeClients = await Client.find({ status: 'active' });
  const map = new Map();
  for (const client of activeClients) {
    if (client.shareFilePathIsAbsolute) continue;
    const topSegment = (client.shareFilePath || client.name).split('/')[0].trim().toLowerCase();
    if (topSegment && !map.has(topSegment)) map.set(topSegment, client);
  }
  return map;
};

const scanShareFileClientsTree = async ({ since = getShareFileIngestSince() } = {}) => {
  const { shareFileRootPath } = await getSettings();
  let context = await getShareFileContext();
  const { apiBase } = context;
  const accountRootId = context.rootId;
  let authHeaders = context.authHeaders;

  const onUnauthorized = async () => {
    context = await getShareFileContext({ forceRefresh: true });
    authHeaders = context.authHeaders;
    return authHeaders;
  };

  const errors = [];
  const result = {
    since: since.toISOString(),
    foldersScanned: 0,
    matchedFolders: 0,
    unmatchedFolders: 0,
    foldersSkippedNoRecentActivity: 0,
    newFiles: [],
    filesSeen: 0,
    unmatchedFilesRecorded: 0,
    filesSkippedBeforeCutoff: 0,
    autoResolvedFiles: 0,
    downloadFailures: 0,
    pathMismatchFiles: 0,
    removedFolderPlaceholders: 0,
    errors,
  };

  let clientsRootId = accountRootId;
  if (shareFileRootPath) {
    const rootResponse = await sfFetch(
      `${apiBase}/Items(${accountRootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`,
      { headers: authHeaders },
      `Resolve ShareFile root "${shareFileRootPath}"`,
      { onUnauthorized }
    );
    if (!rootResponse.ok) {
      const body = await rootResponse.text();
      throw new Error(`ShareFile root path "${shareFileRootPath}" could not be resolved (${rootResponse.status}): ${body}`);
    }
    clientsRootId = (await rootResponse.json()).Id;
  }

  const topChildren = await listAllChildren(clientsRootId, apiBase, authHeaders, `"${shareFileRootPath || 'root'}"`, {
    onUnauthorized,
  });
  const folderMap = await buildActiveClientFolderMap();

  for (const child of topChildren) {
    const name = child.Name || child.FileName || '(unnamed)';

    if (isFileItem(child)) {
      result.filesSeen += 1;
      if (isBeforeCutoff(child, since)) {
        result.filesSkippedBeforeCutoff += 1;
        continue;
      }
      const filePath = shareFileRootPath ? `${shareFileRootPath}/${name}` : name;
      if (await recordUnmatchedFile(child, filePath)) result.unmatchedFilesRecorded += 1;
      continue;
    }

    result.foldersScanned += 1;
    const folderPath = shareFileRootPath ? `${shareFileRootPath}/${name}` : name;
    const matchedClient = folderMap.get(name.trim().toLowerCase());

    const treeProgeny = parseShareFileDate(child.ProgenyEditDate);
    if (treeProgeny && treeProgeny < since && !matchedClient) {
      const removed = await UnmatchedShareFileItem.deleteMany({ path: folderPath });
      result.removedFolderPlaceholders += removed.deletedCount || 0;
      result.foldersSkippedNoRecentActivity += 1;
      continue;
    }

    const scanState = { files: [], capped: false, depthLimited: false };
    try {
      await collectFilesInTree(child.Id, folderPath, apiBase, authHeaders, { onUnauthorized, since, state: scanState });
    } catch (error) {
      const message = `Could not scan "${folderPath}": ${formatError(error)}`;
      console.warn(`  [SHAREFILE SCAN] ${message}`);
      errors.push({ scope: folderPath, message });
      continue;
    }
    if (scanState.capped) {
      errors.push({
        scope: folderPath,
        message: `"${folderPath}" holds more than ${MAX_FILES_PER_CLIENT_FOLDER} files - only the first ${MAX_FILES_PER_CLIENT_FOLDER} were scanned this cycle.`,
      });
    }
    if (scanState.depthLimited) {
      errors.push({
        scope: folderPath,
        message: `"${folderPath}" nests deeper than ${SUBFOLDER_SCAN_MAX_DEPTH} levels - files below that depth were not scanned.`,
      });
    }

    const treeFiles = scanState.files;
    const postCutoffFiles = treeFiles.filter((entry) => !isBeforeCutoff(entry.item, since));
    result.filesSeen += treeFiles.length;
    result.filesSkippedBeforeCutoff += treeFiles.length - postCutoffFiles.length;

    const removed = await UnmatchedShareFileItem.deleteMany({ path: folderPath });
    result.removedFolderPlaceholders += removed.deletedCount || 0;

    if (matchedClient) {
      result.matchedFolders += 1;

      const treeFileIds = treeFiles.map((entry) => entry.item.Id);
      if (treeFileIds.length > 0) {
        const resolvedFiles = await UnmatchedShareFileItem.updateMany(
          { status: 'unresolved', itemId: { $in: treeFileIds } },
          { status: 'resolved', resolvedClientId: matchedClient._id, resolvedAt: new Date() }
        );
        result.autoResolvedFiles += resolvedFiles.modifiedCount || 0;
      }

      const baseSegment = matchedClient.dropboxPath || matchedClient.name;
      for (const { item: file, path: filePath } of postCutoffFiles) {
        const alreadyIngested = await FileLog.findOne({
          source: 'sharefile',
          sourceFileId: file.Id,
          clientId: matchedClient._id,
          status: { $ne: 'failed' },
        });
        if (alreadyIngested) continue;

        const relDir = filePath.slice(folderPath.length + 1).split('/').slice(0, -1).join('/');
        try {
          const content = await downloadFileContentById(file.Id);
          result.newFiles.push({
            clientId: matchedClient._id,
            clientName: matchedClient.name,
            dropboxFolderSegment: relDir ? `${baseSegment}/${relDir}` : baseSegment,
            dropboxIsAbsolute: matchedClient.dropboxPathIsAbsolute,
            fileName: file.Name || file.FileName,
            fileId: file.Id,
            sourceCreatedAt: shareFileItemCreatedAt(file),
            content,
          });
        } catch (error) {
          result.downloadFailures += 1;
          const message = `Could not download "${file.Name}" for "${matchedClient.name}": ${formatError(error)}`;
          console.error(`  [SHAREFILE SCAN] ${message}`);
          errors.push({ scope: folderPath, message });
        }
      }

      await sleep(INTER_FOLDER_DELAY_MS);
      continue;
    }

    result.unmatchedFolders += 1;
    for (const { item: file, path: filePath } of postCutoffFiles) {
      if (await recordUnmatchedFile(file, filePath)) result.unmatchedFilesRecorded += 1;
    }
    await sleep(INTER_FOLDER_DELAY_MS);
  }

  try {
    const clients = await Client.find();
    for (const client of clients) {
      result.pathMismatchFiles += await scanClientPathForMismatches(
        client,
        shareFileRootPath,
        apiBase,
        authHeaders,
        accountRootId
      );
    }
  } catch (error) {
    const message = `Path-mismatch scan failed: ${formatError(error)}`;
    console.warn(`  [SHAREFILE SCAN] ${message}`);
    errors.push({ scope: 'path-mismatch', message });
  }

  return result;
};

const scanShareFileRootForUnmatchedItems = async () => {
  const treeScan = await scanShareFileClientsTree();
  return {
    scanned: treeScan.foldersScanned,
    newOrphans: treeScan.unmatchedFilesRecorded + treeScan.pathMismatchFiles,
    autoResolved: treeScan.autoResolvedFiles,
  };
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
  findLatestLogiFormsCsvInShareFile,
  fetchFileFromShareFile,
  scanShareFileForNewFiles,
  scanShareFileClientsTree,
  ensureShareFileFolderExists,
  deleteShareFileFolder,
  deleteShareFileItemById,
  scanShareFileRootForUnmatchedItems,
  downloadFileContentById,
  getShareFileIngestSince,
};
