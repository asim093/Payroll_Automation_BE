
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { isShareFilePathIgnored, shareFileFolderAssignClientId } = require('./ignoreRuleService');
const { resolveFolderPath } = require('../utils/folderPath');
const { getAccessToken: getShareFileAccessTokenCoordinated } = require('./shareFileTokenManager');

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
const SF_FETCH_MAX_ATTEMPTS = 6;
const SF_RETRY_BASE_DELAY_MS = 500;

const isTransientStatus = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

const SF_FETCH_MAX_AUTH_RETRIES = 2;

const defaultReauth = async () => {
  const { accessToken } = await getShareFileAccessToken({ forceRefresh: true });
  return { Authorization: `Bearer ${accessToken}` };
};

const sfFetch = async (url, options = {}, label = 'ShareFile request', { onUnauthorized = defaultReauth } = {}) => {
  let lastError;
  let headers = options.headers;
  let authRetries = 0;
  for (let attempt = 1; attempt <= SF_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SF_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 401 && onUnauthorized && authRetries < SF_FETCH_MAX_AUTH_RETRIES) {
        authRetries += 1;
        console.warn(
          `${label}: HTTP 401 - refreshing ShareFile token and retrying (${authRetries}/${SF_FETCH_MAX_AUTH_RETRIES}).`
        );
        try {
          headers = { ...headers, ...(await onUnauthorized()) };
          await sleep(SF_RETRY_BASE_DELAY_MS * authRetries);
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

const getShareFileAccessToken = async ({ forceRefresh = false } = {}) => {
  try {
    return await getShareFileAccessTokenCoordinated({ forceRefresh });
  } catch (error) {
    const noAuth = /No ShareFile authorization available/i.test(error.message || '');
    if (noAuth && process.env.SHAREFILE_USERNAME && process.env.SHAREFILE_PASSWORD) {
      return getShareFileAccessTokenViaPassword();
    }
    throw error;
  }
};

const SHAREFILE_ROOT_ALIAS = 'allshared';

const getShareFileContext = async ({ forceRefresh = false } = {}) => {
  const { accessToken, subdomain } = await getShareFileAccessToken({ forceRefresh });
  const apiBase = `https://${subdomain}.sf-api.com/sf/v3`;
  let authHeaders = { Authorization: `Bearer ${accessToken}` };

  const onUnauthorized = async () => {
    const refreshed = await getShareFileAccessToken({ forceRefresh: true });
    authHeaders = { Authorization: `Bearer ${refreshed.accessToken}` };
    return authHeaders;
  };

  try {
    const rootResponse = await sfFetch(
      `${apiBase}/Items(${SHAREFILE_ROOT_ALIAS})`,
      { headers: authHeaders },
      'Resolve ShareFile root',
      { onUnauthorized }
    );

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
    let context = await getShareFileContext();
    const { apiBase } = context;
    let authHeaders = context.authHeaders;
    const onUnauthorized = async () => {
      context = await getShareFileContext({ forceRefresh: true });
      authHeaders = context.authHeaders;
      return authHeaders;
    };

    let currentId = context.rootId;
    let anyCreated = false;

    for (const segment of segments) {
      const childrenResponse = await sfFetch(
        `${apiBase}/Items(${currentId})/Children`,
        { headers: authHeaders },
        `List children while walking to "${fullPath}"`,
        { onUnauthorized }
      );
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

      const createResponse = await sfFetch(
        `${apiBase}/Items(${currentId})/Folder`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ Name: segment }),
        },
        `Create folder "${segment}" under "${fullPath}"`,
        { onUnauthorized }
      );
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
    const downloadResponse = await sfFetch(downloadUrl, { headers: authHeaders }, `Download ShareFile item ${fileId}`);
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

    const folderResponse = await sfFetch(
      `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(cleanPath)}`,
      { headers: authHeaders },
      `Resolve "${cleanPath}"`
    );
    if (!folderResponse.ok) {
      const errorBody = await folderResponse.text();
      throw new Error(`ShareFile folder not found for "${cleanPath}" (${folderResponse.status}): ${errorBody}`);
    }
    const folder = await folderResponse.json();

    const childrenResponse = await sfFetch(
      `${apiBase}/Items(${folder.Id})/Children`,
      { headers: authHeaders },
      `List "${cleanPath}"`
    );
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
      const itemResponse = await sfFetch(byPathUrl, { headers: authHeaders }, `Resolve "${itemPath}"`);
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
  if (await isShareFilePathIgnored(path)) {
    return false;
  }

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
      const rootResponse = await sfFetch(
        `${apiBase}/Items(${accountRootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`,
        { headers: authHeaders },
        `Resolve root "${shareFileRootPath}"`
      );
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
    let matchedClient = folderMap.get(name.trim().toLowerCase());
    if (!matchedClient) {
      const assignClientId = await shareFileFolderAssignClientId(folderPath);
      if (assignClientId) {
        matchedClient = await Client.findById(assignClientId);
      }
    }

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
      const freshMatchedClient = await Client.findById(matchedClient._id);
      matchedClient = freshMatchedClient && freshMatchedClient.status === 'active' ? freshMatchedClient : null;
    }

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
    const childrenResponse = await sfFetch(
      `${apiBase}/Items(${currentId})/Children`,
      { headers: authHeaders },
      `Walk to "${fullPath}"`
    );
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

const renameShareFileFolder = async (fromFullPath, toFullPath) => {
  const fromSegs = fromFullPath.split('/').map((part) => part.trim()).filter(Boolean);
  const toSegs = toFullPath.split('/').map((part) => part.trim()).filter(Boolean);

  if (fromSegs.length !== toSegs.length) return { renamed: false, reason: 'shape-changed' };
  const diffIdx = fromSegs.findIndex((seg, i) => seg.toLowerCase() !== toSegs[i].toLowerCase());
  if (diffIdx === -1) return { renamed: false, reason: 'unchanged' };
  if (
    fromSegs.slice(diffIdx + 1).join('/').toLowerCase() !== toSegs.slice(diffIdx + 1).join('/').toLowerCase()
  ) {
    return { renamed: false, reason: 'multi-segment-change' };
  }

  const fromFolderPath = fromSegs.slice(0, diffIdx + 1).join('/');
  const toFolderPath = toSegs.slice(0, diffIdx + 1).join('/');
  const newName = toSegs[diffIdx];

  let context = await getShareFileContext();
  const onUnauthorized = async () => {
    context = await getShareFileContext({ forceRefresh: true });
    return context.authHeaders;
  };

  const folderId = await resolveShareFileFolderId(fromFolderPath);
  if (!folderId) return { renamed: false, reason: 'source-missing' };

  const existingTargetId = await resolveShareFileFolderId(toFolderPath);
  if (existingTargetId && existingTargetId !== folderId) return { renamed: false, reason: 'target-exists' };

  const response = await sfFetch(
    `${context.apiBase}/Items(${folderId})`,
    {
      method: 'PATCH',
      headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: newName }),
    },
    `Rename ShareFile folder "${fromFolderPath}" -> "${newName}"`,
    { onUnauthorized }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Could not rename ShareFile folder "${fromFolderPath}" (${response.status}): ${body}`);
  }

  console.log(`  [SHAREFILE] Renamed folder "${fromFolderPath}" -> "${toFolderPath}".`);
  return { renamed: true, from: fromFolderPath, to: toFolderPath };
};

const deleteShareFileFolder = async (fullPath) => {
  try {
    const { apiBase, authHeaders } = await getShareFileContext();
    const folderId = await resolveShareFileFolderId(fullPath);
    if (!folderId) {
      return { deleted: false, path: fullPath, folderId: null };
    }

    const deleteResponse = await sfFetch(
      `${apiBase}/Items(${folderId})`,
      { method: 'DELETE', headers: authHeaders },
      `Delete ShareFile folder "${fullPath}"`
    );
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const errorBody = await deleteResponse.text();
      throw new Error(`Could not delete folder "${fullPath}" (${deleteResponse.status}): ${errorBody}`);
    }

    console.log(`  [SHAREFILE] Deleted folder "${fullPath}" (id ${folderId}).`);
    return { deleted: true, path: fullPath, folderId };
  } catch (error) {
    console.error(`deleteShareFileFolder ERROR ("${fullPath}"): ${formatError(error)}`);
    throw error;
  }
};

const deleteShareFileItemById = async (itemId) => {
  const { apiBase, authHeaders } = await getShareFileContext();
  const deleteResponse = await sfFetch(
    `${apiBase}/Items(${itemId})`,
    { method: 'DELETE', headers: authHeaders },
    `Delete ShareFile item ${itemId}`
  );
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const errorBody = await deleteResponse.text();
    throw new Error(`Could not delete item ${itemId} (${deleteResponse.status}): ${errorBody}`);
  }
  console.log(`  [SHAREFILE] Deleted item ${itemId}.`);
  return { deleted: true };
};

// Number of items directly under a folder (by folder id). Best effort: returns
// null if it can't be determined. Used only to tell the operator that a newly
// created client is being pointed at a folder that already holds files.
const shareFileFolderChildCount = async (folderId) => {
  try {
    const { apiBase, authHeaders } = await getShareFileContext();
    const response = await sfFetch(
      `${apiBase}/Items(${folderId})/Children?$select=Id`,
      { headers: authHeaders },
      `Count children of ShareFile folder ${folderId}`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return (data.value || []).length;
  } catch {
    return null;
  }
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
  renameShareFileFolder,
  deleteShareFileFolder,
  deleteShareFileItemById,
  shareFileFolderChildCount,
  scanShareFileRootForUnmatchedItems,
  downloadFileContentById,
  getShareFileIngestSince,
};
