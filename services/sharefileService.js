/**
 * Real ShareFile integration — replaces the earlier local-folder simulation.
 * Uses ShareFile's OAuth2 "password grant" flow + the v3 REST API to look
 * up and download files from Clients/{clientName}/.
 */
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { formatError } = require('../utils/formatError');

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
 * Lists every file (not subfolders) directly inside Clients/{clientName}/.
 * Throws if the folder doesn't exist — callers that want to treat a missing
 * folder as "just no files yet" should catch that themselves.
 */
const listFilesInShareFileFolder = async (clientName) => {
  const folderPath = `Clients/${clientName}`;

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
 * Finds the most recently uploaded file inside Clients/{clientName}/.
 * Returns { fileName, fileId, uploadedAt }. Throws a clear error if the
 * folder doesn't exist or has no files in it.
 */
const getLatestFileInShareFileFolder = async (clientName) => {
  try {
    const files = await listFilesInShareFileFolder(clientName);
    if (files.length === 0) {
      throw new Error(`No files found in ShareFile folder for client "${clientName}"`);
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
      `getLatestFileInShareFileFolder ERROR: could not find latest file for "${clientName}" — ${formatError(error)}`
    );
    throw error;
  }
};

/**
 * Fetch a file from ShareFile at Clients/{clientName}/{fileName} — or, if
 * fileName is omitted, auto-detects and downloads the most recently
 * uploaded file in that client's folder instead (see
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
 * @param {string} clientName
 * @param {string} [fileName] - omit to auto-detect the latest file
 */
const fetchFileFromShareFile = async (clientName, fileName) => {
  try {
    let fileId;
    let resolvedFileName;

    if (fileName) {
      // Explicit filename given (e.g. for testing) — look it up by path.
      resolvedFileName = fileName;
      const { apiBase, authHeaders, homeId } = await getShareFileContext();
      const itemPath = `Clients/${clientName}/${fileName}`;
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
      const latest = await getLatestFileInShareFileFolder(clientName);
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
      `fetchFileFromShareFile ERROR: could not fetch file for client "${clientName}"${
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
 * Returns an array of { clientId, clientName, fileName, fileId, content } —
 * one entry per new file found, content already downloaded.
 */
const scanShareFileForNewFiles = async () => {
  const activeClients = await Client.find({ status: 'active' });
  const newFiles = [];

  for (const client of activeClients) {
    let files;
    try {
      files = await listFilesInShareFileFolder(client.name);
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

module.exports = {
  getShareFileAccessToken,
  getLatestFileInShareFileFolder,
  fetchFileFromShareFile,
  scanShareFileForNewFiles,
};
