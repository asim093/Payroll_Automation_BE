const { Dropbox } = require('dropbox');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { joinFolderPath } = require('../utils/folderPath');
const Client = require('../models/Client');
const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');

// Same sanitization approach as fileStorage.js — client/file names can
// contain characters that aren't safe in a Dropbox path.
const sanitizeForPath = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_').trim();

/**
 * Exchanges the long-lived DROPBOX_REFRESH_TOKEN for a fresh, short-lived
 * access token — called before every upload so uploadFileToDropbox() never
 * relies on a manually-pasted static token that eventually expires. See
 * getDropboxRefreshToken.js for how the refresh token itself is obtained
 * (one-time manual login).
 */
const getDropboxAccessToken = async () => {
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  if (!refreshToken) {
    throw new Error('DROPBOX_REFRESH_TOKEN is not set in .env. Pehle getDropboxRefreshToken.js chalayein.');
  }
  if (!appKey || !appSecret) {
    throw new Error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET is not set in .env.');
  }

  try {
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
    return data.access_token;
  } catch (error) {
    console.error(`getDropboxAccessToken ERROR: ${formatError(error)}`);
    throw error;
  }
};

/**
 * Upload a file to Dropbox. The destination FOLDER is Settings'
 * dropboxRootPath (a free-text root path, admin-editable via
 * PUT /api/settings — see settingsService.js) joined with clientFolderSegment
 * (see utils/folderPath.js's joinFolderPath()) — e.g. root "WOTC" + client
 * path "Acme Corp/Payroll Files" -> "WOTC/Acme Corp/Payroll Files". The
 * timestamp prefix (see generateUniqueFilename)
 * stops two attachments with the same original name from overwriting each
 * other — without it, "overwrite" mode below would silently replace an
 * earlier file that happened to share a name. Returns the uploaded file's
 * Dropbox path on success.
 *
 * @param {string} clientFolderSegment - the client-specific part of the
 *   path. Callers pass client.dropboxPath if set, falling back to
 *   client.name otherwise (see emailProcessor.js/processShareFileScan.js) —
 *   this function itself doesn't know about the Client model, it just
 *   substitutes whatever string it's given into the template.
 * @param {string} fileName
 * @param {Buffer} contentBuffer
 * @param {Date} [referenceDate] - pass the same Date used for other
 *   destinations (e.g. local disk) of this same attachment, so both end up
 *   with an identical unique filename.
 */
// Shared by uploadFileToDropbox() and ensureDropboxFolderExists() so both
// always resolve a client's folder to the exact same path.
const resolveDropboxFolderPath = async (clientFolderSegment) => {
  const { dropboxRootPath } = await getSettings();
  const resolvedFolder = joinFolderPath(dropboxRootPath, clientFolderSegment);
  // Split on "/" first (the resolved path's own directory separators), THEN
  // sanitize each individual segment - sanitizeForPath also strips "/" so
  // running it on the whole resolved string first would collapse the
  // intentional folder structure into one flat name.
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
    // error.error is the Dropbox SDK's parsed API error body (when the
    // request reached Dropbox); when fetch() fails before that (network
    // issue), fall back to formatError() to surface error.cause instead of
    // just the generic "fetch failed".
    const message = error?.error?.error_summary || formatError(error) || 'Unknown error';
    console.error(
      `uploadFileToDropbox ERROR: could not upload "${fileName}" for "${clientFolderSegment}" — status: ${status} — ${message}`
    );
    throw error;
  }
};

/**
 * Checks whether a client's Dropbox folder already exists, creating it
 * (empty) if it doesn't. Used at client-add/edit time (see
 * services/clientFolderSetupService.js) — NOT called on every upload, since
 * filesUpload() already auto-creates any missing intermediate folders on
 * its own (confirmed Dropbox API behaviour), so this is purely for the
 * "give the admin visible confirmation the folder is ready" requirement.
 *
 * Verified against the real API (not guessed): filesGetMetadata() on a
 * missing path returns HTTP 409 with error_summary starting
 * "path/not_found"; filesCreateFolderV2() on a path that already exists (a
 * check-then-create race) returns "path/conflict" — both are handled
 * explicitly below, anything else is a real error and gets re-thrown.
 *
 * @param {string} clientFolderSegment - client.dropboxPath || client.name
 * @returns {Promise<{created: boolean, path: string}>}
 */
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
      // Created by something else between our check and this call - fine,
      // it exists now either way.
      return { created: false, path: folderPath };
    }
    console.error(`ensureDropboxFolderExists ERROR (creating "${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

/**
 * Deletes a client's Dropbox folder (and everything inside it) — used when
 * an admin opts in to folder-cleanup while deleting a client (see
 * services/clientFolderCleanupService.js). A folder that's already gone is
 * NOT an error — filesDeleteV2() on a missing path returns
 * "path_lookup/not_found", treated the same as "already deleted".
 *
 * @param {string} clientFolderSegment - client.dropboxPath || client.name
 * @returns {Promise<{deleted: boolean, path: string}>}
 */
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

/**
 * Dropbox counterpart of sharefileService.js's
 * scanShareFileRootForUnmatchedItems() — walks Settings' dropboxRootPath
 * ONE level deep looking for files/folders that don't belong to any known
 * client, tracking anything found in UnmatchedDropboxItem (repeat scans
 * refresh lastSeenAt/isEmpty instead of duplicating). A folder that now
 * matches a known client (e.g. the client was only just added, or its path
 * only just changed to point here) auto-clears any stale flag from an
 * earlier scan, same as the ShareFile version.
 *
 * Bounded to the root level only (no recursive per-client mismatch-walk
 * like ShareFile's Phase 6 extension) — Dropbox is this system's FINAL
 * destination, not a source new files get pulled from, so there's no
 * per-client "did something land outside the expected path" scan to mirror
 * here, only "is there a stray top-level item that isn't a known client's
 * folder at all".
 *
 * @returns {Promise<{scanned: number, newOrphans: number, autoResolved: number}>}
 */
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
      // Root folder doesn't exist yet - nothing to scan (not an error; a
      // brand-new/empty Dropbox setup legitimately has no root folder yet).
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

    // Folders get one extra call to check whether they're empty - shown on
    // the Review Queue so an empty one (often just a leftover from a
    // client's path being changed) can be offered a one-click delete
    // instead of only "assign to a client".
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

/**
 * Deletes a single Dropbox file/folder by its live path - used from the
 * Unmatched Dropbox Items list (see unmatchedDropboxItemController.js) to
 * remove an empty leftover folder directly. A path that's already gone is
 * NOT an error.
 *
 * @param {string} path - entry.path_lower from the scan above
 * @returns {Promise<{deleted: boolean}>}
 */
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

/**
 * Moves a stray Dropbox file (found sitting outside any known client's
 * folder - see scanDropboxRootForUnmatchedItems() above) into a client's
 * proper Dropbox folder. Used when resolving a "file"-type unmatched item
 * - unlike ShareFile's equivalent (which downloads from ShareFile and
 * uploads to Dropbox, since those are two different systems), this is a
 * same-system move: the file is already in Dropbox, just in the wrong
 * place. autorename avoids a collision if the destination already happens
 * to have a file with the same name.
 *
 * @param {string} fromPath - entry.path_lower from the scan
 * @param {string} clientFolderSegment - client.dropboxPath || client.name
 * @param {string} fileName
 * @returns {Promise<string>} the file's new Dropbox path
 */
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
