/**
 * Real ShareFile integration — replaces the earlier local-folder simulation.
 * Uses ShareFile's OAuth2 "password grant" flow + the v3 REST API to look
 * up and download files from Clients/{clientName}/.
 */
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');

/**
 * Authenticate with ShareFile via the OAuth2 password grant flow.
 * Returns { accessToken, subdomain } — subdomain is needed to build the
 * account's API base URL (https://{subdomain}.sf-api.com/sf/v3).
 */
const getShareFileAccessToken = async () => {
  const {
    SHAREFILE_CLIENT_ID,
    SHAREFILE_CLIENT_SECRET,
    SHAREFILE_USERNAME,
    SHAREFILE_PASSWORD,
    SHAREFILE_SUBDOMAIN,
  } = process.env;

  if (
    !SHAREFILE_CLIENT_ID ||
    !SHAREFILE_CLIENT_SECRET ||
    !SHAREFILE_USERNAME ||
    !SHAREFILE_PASSWORD ||
    !SHAREFILE_SUBDOMAIN
  ) {
    throw new Error(
      'ShareFile credentials missing in .env (SHAREFILE_CLIENT_ID/SHAREFILE_CLIENT_SECRET/SHAREFILE_USERNAME/SHAREFILE_PASSWORD/SHAREFILE_SUBDOMAIN).'
    );
  }

  // The token endpoint is account-specific, not the generic secure.sharefile.com
  // host — password grant has to be requested against the account's own
  // subdomain.
  const authUrl = `https://${SHAREFILE_SUBDOMAIN}.sharefile.com/oauth/token`;

  try {
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
    return { accessToken: data.access_token, subdomain: data.subdomain };
  } catch (error) {
    console.error(`getShareFileAccessToken ERROR: ${formatError(error)}`);
    throw error;
  }
};

/**
 * Authenticates and resolves the "home" alias to its real Item Id in one
 * call — every ByPath lookup needs to be scoped to that real id (see note
 * below), so every function in this file that needs the folder tree starts
 * here.
 */
const getShareFileContext = async () => {
  const { accessToken, subdomain } = await getShareFileAccessToken();
  const apiBase = `https://${subdomain}.sf-api.com/sf/v3`;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // ByPath has to be scoped to a starting item's real Id — Items(home)/ByPath
  // (using the alias directly as the scope) 404s even though Items(home)
  // itself resolves fine; Clients/ lives under this personal-folders root,
  // not whatever unscoped Items/ByPath defaults to.
  try {
    const homeResponse = await fetch(`${apiBase}/Items(home)`, { headers: authHeaders });
    if (!homeResponse.ok) {
      const errorBody = await homeResponse.text();
      throw new Error(`Could not resolve home folder (${homeResponse.status}): ${errorBody}`);
    }
    const home = await homeResponse.json();

    return { apiBase, authHeaders, homeId: home.Id };
  } catch (error) {
    // If fetch() itself throws (network-level failure, not an HTTP error
    // response), error.message is just the generic "fetch failed" — the
    // real reason is in error.cause. formatError() surfaces both.
    console.error(`getShareFileContext ERROR (resolving home): ${formatError(error)}`);
    throw error;
  }
};

// ShareFile item Ids are prefixed by type ("fo..." = folder, "fi..." = file)
// — more reliable across API responses than relying on odata.type always
// being present in every payload shape.
const isFileItem = (item) =>
  item['odata.type'] ? item['odata.type'].includes('.File') : typeof item.Id === 'string' && item.Id.startsWith('fi');

/**
 * Checks whether a client's ShareFile folder already exists, creating any
 * missing segment (walking one level at a time from the account's home
 * folder) if it doesn't. Used at client-add/edit time (see
 * services/clientFolderSetupService.js).
 *
 * CAPABILITY CONFIRMED LIVE (not assumed): tested POST
 * Items({parentId})/Folder against the real ShareFile trial account this
 * project uses - it returned HTTP 200 with "CanAddFolder": true in the
 * created item's Info, so folder-creation IS available on this account/API
 * tier. If a real account without that permission gets a 403 here, this
 * throws with ShareFile's own error body rather than silently pretending to
 * succeed - callers (clientFolderSetupService.js) turn that into a visible
 * "can't auto-create, do it manually" warning instead of guessing.
 *
 * @param {string} fullPath - the already-resolved path, e.g.
 *   "Clients/Acme Corp/Payroll Files" (root path + client's own path, see
 *   utils/folderPath.js's joinFolderPath()).
 * @returns {Promise<{created: boolean, folderId: string}>}
 */
const ensureShareFileFolderExists = async (fullPath) => {
  const segments = fullPath
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  try {
    const { apiBase, authHeaders, homeId } = await getShareFileContext();
    let currentId = homeId;
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

/**
 * Lists every file (not subfolders) directly inside the folder resolved
 * from Settings' shareFileRootPath (a free-text root path, admin-editable
 * via PUT /api/settings) joined with clientFolderSegment (see
 * utils/folderPath.js's joinFolderPath()). Throws if the folder doesn't
 * exist — callers that want to treat a missing folder as "just no files
 * yet" should catch that themselves.
 *
 * @param {string} clientFolderSegment - the client-specific part of the
 *   path. Callers pass client.shareFilePath if set, falling back to
 *   client.name otherwise — this function itself doesn't know about the
 *   Client model.
 */
const listFilesInShareFileFolder = async (clientFolderSegment) => {
  const { shareFileRootPath } = await getSettings();
  const folderPath = joinFolderPath(shareFileRootPath, clientFolderSegment);

  try {
    const { apiBase, authHeaders, homeId } = await getShareFileContext();

    const folderByPathUrl = `${apiBase}/Items(${homeId})/ByPath?path=${encodeURIComponent(folderPath)}`;
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
    // Re-thrown as-is (callers like scanShareFileForNewFiles() decide how to
    // handle it — e.g. skip that client) but logged here with full detail
    // first, since formatError() surfaces error.cause for raw network
    // failures that would otherwise just say "fetch failed".
    console.error(`listFilesInShareFileFolder ERROR ("${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

/**
 * Downloads a file's content by its ShareFile Item Id directly (no path
 * lookup needed — used once we already know the Id, e.g. from
 * listFilesInShareFileFolder()). ShareFile's Download endpoint either
 * redirects straight to the file bytes, or returns a DownloadSpecification
 * JSON with a DownloadUrl — handles both.
 */
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

/**
 * Finds the most recently uploaded file inside the folder resolved from
 * Settings' shareFileRootPath for clientFolderSegment. Returns
 * { fileName, fileId, uploadedAt }. Throws a clear error if the folder
 * doesn't exist or has no files in it.
 */
const getLatestFileInShareFileFolder = async (clientFolderSegment) => {
  try {
    const files = await listFilesInShareFileFolder(clientFolderSegment);
    if (files.length === 0) {
      throw new Error(`No files found in ShareFile folder for "${clientFolderSegment}"`);
    }

    // Newest first — CreationDate is when the file was uploaded;
    // ProgenyEditDate as a fallback for items missing it.
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

/**
 * Fetch a file from ShareFile at {resolved shareFileRootPath}/{fileName}
 * — or, if fileName is omitted, auto-detects and downloads the most
 * recently uploaded file in that folder instead (see
 * getLatestFileInShareFileFolder()).
 *
 * NOTE: this notification-triggered, single-file fetch is the OLD approach.
 * The active flow is now scanShareFileForNewFiles() below (a periodic scan,
 * not tied to any one notification) — see the DEPRECATED note on the
 * ShareFile-notification block in emailProcessor.js. This function is kept
 * because that old block still calls it.
 *
 * Returns { content: Buffer, fileName: string } — fileName is always
 * present so callers know what was actually fetched, which matters when it
 * was auto-detected rather than passed in explicitly.
 *
 * @param {string} clientFolderSegment - the client-specific part of the
 *   path. Callers pass client.shareFilePath if set, falling back to
 *   client.name otherwise.
 * @param {string} [fileName] - omit to auto-detect the latest file
 */
const fetchFileFromShareFile = async (clientFolderSegment, fileName) => {
  try {
    let fileId;
    let resolvedFileName;

    if (fileName) {
      // Explicit filename given (e.g. for testing) — look it up by path.
      resolvedFileName = fileName;
      const { apiBase, authHeaders, homeId } = await getShareFileContext();
      const { shareFileRootPath } = await getSettings();
      const itemPath = `${joinFolderPath(shareFileRootPath, clientFolderSegment)}/${fileName}`;
      const byPathUrl = `${apiBase}/Items(${homeId})/ByPath?path=${encodeURIComponent(itemPath)}`;
      const itemResponse = await fetch(byPathUrl, { headers: authHeaders });
      if (!itemResponse.ok) {
        const errorBody = await itemResponse.text();
        throw new Error(`Item lookup failed (${itemResponse.status}): ${errorBody}`);
      }
      const item = await itemResponse.json();
      fileId = item.Id;
    } else {
      // No filename given -> auto-detect the most recently uploaded file.
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

/**
 * Scans every ACTIVE client's ShareFile folder for files that haven't been
 * processed yet, tracked via FileLog.sourceFileId — the notification-
 * independent replacement for the old single-file, notification-triggered
 * fetch above. A client whose folder doesn't exist yet is skipped (logged,
 * not fatal) rather than failing the whole scan.
 *
 * Looks the folder up under client.shareFilePath (falling back to
 * client.name for clients created before that field existed), but the
 * files it finds are Dropbox-bound under client.dropboxPath instead — the
 * two folder segments are independent per-client settings, so both are
 * carried through on each returned file (see dropboxFolderSegment).
 *
 * Returns an array of
 * { clientId, clientName, dropboxFolderSegment, fileName, fileId, content }
 * — one entry per new file found, content already downloaded.
 */
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
      const alreadyProcessed = await FileLog.findOne({ sourceFileId: file.Id });
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

// Shared by both the root-level scan and the per-client mismatch-walk below
// — upserts one unmatched item: creates it if genuinely new, refreshes
// lastSeenAt if it's already tracked and still unresolved, and leaves
// resolved/dismissed ones alone (repeat scans must never un-resolve
// something an admin already handled).
const recordUnmatchedItem = async (item, path) => {
  const isFile = isFileItem(item);
  const existing = await UnmatchedShareFileItem.findOne({ itemId: item.Id });
  if (existing) {
    if (existing.status === 'unresolved') {
      existing.lastSeenAt = new Date();
      await existing.save();
    }
    return false;
  }

  await UnmatchedShareFileItem.create({
    itemId: item.Id,
    itemType: isFile ? 'file' : 'folder',
    name: item.Name || item.FileName || '(unnamed)',
    path,
    discoveredAt: new Date(),
    lastSeenAt: new Date(),
    status: 'unresolved',
  });
  console.log(`  [SHAREFILE ORPHAN SCAN] New unmatched ${isFile ? 'file' : 'folder'}: "${path}"`);
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

// PHASE 6 — extends the root-level scan below to also catch a file/folder
// sitting INSIDE a KNOWN client's top-level ShareFile folder but OUTSIDE
// the exact nested path that client is actually configured to use. E.g.
// client "Acme Corp" has shareFilePath "Acme Corp/Payroll Files" — the
// regular per-client scan (listFilesInShareFileFolder) only ever reads
// directly inside ".../Payroll Files", so a file sitting loose in
// ".../Acme Corp/" itself, or in some other sibling subfolder, would
// otherwise never be looked at by anything. Only relevant for clients whose
// configured path has 2+ segments — a single-segment client's whole
// top-level folder already IS what the per-client scan reads.
//
// Walks down through each nested-path client's OWN expected chain one
// level at a time, flagging siblings (anything at that level that ISN'T
// the next expected segment) at every level - stops descending once the
// expected chain breaks (that "folder doesn't exist yet" case is already
// surfaced separately by the per-client scan's own try/catch).
const scanClientPathForMismatches = async (client, shareFileRootPath, apiBase, authHeaders, homeId) => {
  const expectedSegments = (client.shareFilePath || client.name)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (expectedSegments.length < 2) return 0; // Nothing nested to check.

  // Resolve the ROOT path's own folder Id first (e.g. "Clients") — without
  // this, the walk below would start listing HOME's direct children
  // instead of the root folder's, never find the client's top-level
  // segment there, and silently return 0 every time.
  let currentId = homeId;
  let currentPath = '';
  if (shareFileRootPath) {
    try {
      const rootResponse = await fetch(`${apiBase}/Items(${homeId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`, {
        headers: authHeaders,
      });
      if (!rootResponse.ok) return 0; // Root path doesn't exist - nothing to walk.
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

    // Level 0 is the client's own top-level folder - its siblings (other
    // clients' folders, other unrelated folders) are the root-scan's job,
    // not this function's. From level 1 onward, everything in this folder
    // that ISN'T the next expected segment is a genuine mismatch: it's
    // physically inside this client's own folder tree, yet outside the
    // path the system actually reads from.
    if (level > 0) {
      for (const child of children) {
        const name = child.Name || child.FileName || '(unnamed)';
        if (!isFileItem(child) && name.trim().toLowerCase() === expectedName.trim().toLowerCase()) {
          continue; // The recognized branch - handled by continuing the walk below.
        }
        const created = await recordUnmatchedItem(child, `${currentPath}/${name}`);
        if (created) newOrphans++;
      }
    }

    const match = children.find(
      (child) => !isFileItem(child) && (child.Name || '').trim().toLowerCase() === expectedName.trim().toLowerCase()
    );
    if (!match) return newOrphans; // Expected chain breaks here - nothing deeper to check.

    currentId = match.Id;
    currentPath = `${currentPath}/${expectedName}`;
  }

  return newOrphans;
};

/**
 * PHASE 5 (+ PHASE 6) — master-folder-scan: lists the DIRECT children of the
 * ShareFile account's root path (Settings' shareFileRootPath) itself,
 * rather than any specific client's path — this is what catches things the
 * normal per-client scan (scanShareFileForNewFiles(), above) would never
 * even look at, since that one only ever checks paths clients already have
 * on file. Then, for every client whose configured path is nested (2+
 * segments), also walks that client's OWN folder chain looking for
 * sibling content outside the exact expected path (see
 * scanClientPathForMismatches() above — this is the Phase 6 extension).
 *
 * Anything found gets tracked in the UnmatchedShareFileItem collection
 * (repeat scans refresh lastSeenAt instead of duplicating) so it can be
 * manually resolved from the Review Queue. Deliberately bounded (root level
 * + one walk per nested-path client, not an unbounded recursive crawl) so
 * this stays cheap enough to run every regular scan cycle (see
 * processShareFileScan.js).
 *
 * @returns {Promise<{scanned: number, newOrphans: number}>}
 */
const scanShareFileRootForUnmatchedItems = async () => {
  const { shareFileRootPath } = await getSettings();
  const { apiBase, authHeaders, homeId } = await getShareFileContext();

  let rootId = homeId;
  if (shareFileRootPath) {
    const rootResponse = await fetch(`${apiBase}/Items(${homeId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`, {
      headers: authHeaders,
    });
    if (!rootResponse.ok) {
      // Root folder doesn't exist yet - nothing to scan (not an error; a
      // brand-new/empty ShareFile setup legitimately has no root folder yet).
      console.log(`  [SHAREFILE ORPHAN SCAN] Root path "${shareFileRootPath}" not found - skipping.`);
      return { scanned: 0, newOrphans: 0 };
    }
    const rootFolder = await rootResponse.json();
    rootId = rootFolder.Id;
  }

  const children = await listChildren(rootId, apiBase, authHeaders);

  const clients = await Client.find();

  // Known top-level folder names = the FIRST path segment of every client's
  // shareFilePath (falling back to client.name) - a client configured with
  // a nested path like "Acme Corp/Payroll Files" is still recognized here
  // by its top-level "Acme Corp" folder, since that's as deep as this
  // level of the scan goes (the nested part is Phase 6's job, above). Maps
  // to the actual Client too (not just a Set of names) so a stale flag can
  // be auto-cleared with a real resolvedClientId - see the loop below.
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
      // Known client folder - the regular per-client scan already covers it
      // going forward. If an EARLIER scan already flagged this exact item
      // as unmatched (e.g. the client didn't exist yet, or its path was
      // only just pointed here), that record would otherwise sit
      // "unresolved" forever - nothing else ever revisits it once the item
      // itself stops being reported as an orphan. Clear it now instead.
      const result = await UnmatchedShareFileItem.updateOne(
        { itemId: item.Id, status: 'unresolved' },
        { status: 'resolved', resolvedClientId: matchedClient._id, resolvedAt: new Date() }
      );
      autoResolved += result.modifiedCount || 0;
      continue;
    }

    const path = shareFileRootPath ? `${shareFileRootPath}/${name}` : name;
    const created = await recordUnmatchedItem(item, path);
    if (created) newOrphans++;
  }

  // PHASE 6 — nested-path mismatch check, one client at a time.
  for (const client of clients) {
    newOrphans += await scanClientPathForMismatches(client, shareFileRootPath, apiBase, authHeaders, homeId);
  }

  return { scanned: children.length, newOrphans, autoResolved };
};

/**
 * Walks to a folder WITHOUT creating any missing segment — returns null if
 * any part of the path doesn't exist. Used by deleteShareFileFolder() below
 * so cleanup never accidentally creates the very folder it's trying to
 * remove.
 */
const resolveShareFileFolderId = async (fullPath) => {
  const segments = fullPath
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  const { apiBase, authHeaders, homeId } = await getShareFileContext();
  let currentId = homeId;

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

/**
 * Deletes a client's ShareFile folder (and everything inside it) — used
 * when an admin opts in to folder-cleanup while deleting a client (see
 * services/clientFolderCleanupService.js). A folder that's already gone is
 * NOT an error.
 *
 * @param {string} fullPath - the already-resolved path (root + client segment)
 * @returns {Promise<{deleted: boolean}>}
 */
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

module.exports = {
  getShareFileAccessToken,
  getLatestFileInShareFileFolder,
  fetchFileFromShareFile,
  scanShareFileForNewFiles,
  ensureShareFileFolderExists,
  deleteShareFileFolder,
  scanShareFileRootForUnmatchedItems,
  downloadFileContentById,
};
