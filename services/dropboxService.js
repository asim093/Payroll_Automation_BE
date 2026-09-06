const fs = require('fs');
const { Dropbox } = require('dropbox');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');
const { formatError } = require('../utils/formatError');
const { getSettings } = require('./settingsService');
const { sanitizeForPath, resolveDropboxFolderPathSync } = require('../utils/folderPath');
const OAuthCredential = require('../models/OAuthCredential');
const {
  PROVIDER_KEY: DROPBOX_OAUTH_PROVIDER_KEY,
  refreshAccessToken,
} = require('./dropboxOAuthSetupService');

const getDropboxPathRoot = () => {
  const namespaceId = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
  if (!namespaceId) return undefined;
  return JSON.stringify({ '.tag': 'namespace_id', namespace_id: namespaceId });
};

const createDropboxClient = (accessToken) => {
  const pathRoot = getDropboxPathRoot();
  return pathRoot ? new Dropbox({ accessToken, fetch, pathRoot }) : new Dropbox({ accessToken, fetch });
};

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

const resolveDropboxFolderPath = async (clientFolderSegment, isAbsolute = false) => {
  const { dropboxRootPath } = await getSettings();
  return resolveDropboxFolderPathSync(dropboxRootPath, clientFolderSegment, isAbsolute);
};

const uploadFileToDropbox = async (clientFolderSegment, fileName, contentBuffer, referenceDate, isAbsolute = false) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);

  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);
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

const ensureDropboxFolderExists = async (clientFolderSegment, isAbsolute = false) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);

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

const folderRenameTarget = (fromResolved, toResolved) => {
  const fromSegs = fromResolved.split('/').filter(Boolean);
  const toSegs = toResolved.split('/').filter(Boolean);
  if (fromSegs.length !== toSegs.length) return { reason: 'shape-changed' };
  const diffIdx = fromSegs.findIndex((seg, i) => seg.toLowerCase() !== toSegs[i].toLowerCase());
  if (diffIdx === -1) return { reason: 'unchanged' };
  const tailFrom = fromSegs.slice(diffIdx + 1).join('/').toLowerCase();
  const tailTo = toSegs.slice(diffIdx + 1).join('/').toLowerCase();
  if (tailFrom !== tailTo) return { reason: 'multi-segment-change' };
  return {
    reason: 'ok',
    from: `/${fromSegs.slice(0, diffIdx + 1).join('/')}`,
    to: `/${toSegs.slice(0, diffIdx + 1).join('/')}`,
  };
};

const renameDropboxFolder = async (fromSegment, fromIsAbsolute, toSegment, toIsAbsolute) => {
  const fromResolved = await resolveDropboxFolderPath(fromSegment, fromIsAbsolute);
  const toResolved = await resolveDropboxFolderPath(toSegment, toIsAbsolute);

  const target = folderRenameTarget(fromResolved, toResolved);
  if (target.reason !== 'ok') return { renamed: false, reason: target.reason };

  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);

  try {
    await dbx.filesGetMetadata({ path: target.from });
  } catch (error) {
    if ((error?.error?.error_summary || '').startsWith('path/not_found')) {
      return { renamed: false, reason: 'source-missing' };
    }
    throw error;
  }

  try {
    await dbx.filesGetMetadata({ path: target.to });
    return { renamed: false, reason: 'target-exists' };
  } catch (error) {
    if (!(error?.error?.error_summary || '').startsWith('path/not_found')) throw error;
  }

  const response = await dbx.filesMoveV2({ from_path: target.from, to_path: target.to });
  console.log(`  [DROPBOX] Renamed folder "${target.from}" -> "${response.result.metadata.path_display}".`);
  return { renamed: true, from: target.from, to: response.result.metadata.path_display };
};

const deleteDropboxFolder = async (clientFolderSegment, isAbsolute = false) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);

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


const PAYROLL_FILE_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

const MAX_LISTED_FILES = 1000;

const listFolderEntries = async (folderPath, callerLabel) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);

  let response;
  try {
    response = await dbx.filesListFolder({ path: folderPath });
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path/not_found')) return [];
    console.error(`${callerLabel} ERROR (listing "${folderPath}"): ${formatError(error)}`);
    throw error;
  }

  const entries = [...response.result.entries];
  while (response.result.has_more && entries.length < MAX_LISTED_FILES) {
    response = await dbx.filesListFolderContinue({ cursor: response.result.cursor });
    entries.push(...response.result.entries);
  }
  return entries;
};

const toFileSummary = (entry) => ({
  name: entry.name,
  path: entry.path_lower,
  modifiedAt: entry.server_modified,
});

const listFilesInFolder = async (clientFolderSegment, isAbsolute, extensions, callerLabel) => {
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);
  const entries = await listFolderEntries(folderPath, callerLabel);

  const candidateFiles = entries.filter(
    (entry) =>
      entry['.tag'] === 'file' &&
      extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))
  );

  candidateFiles.sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));
  return candidateFiles.map(toFileSummary);
};

const listAllFilesInFolder = async (clientFolderSegment, isAbsolute = false) => {
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);
  const entries = await listFolderEntries(folderPath, 'listAllFilesInFolder');

  return entries
    .filter((entry) => entry['.tag'] === 'file')
    .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified))
    .map(toFileSummary);
};

// Total number of items (files + subfolders) directly in a folder, used to tell
// the operator when a newly created client is being pointed at a folder that
// already has contents.
const dropboxFolderContentCount = async (clientFolderSegment, isAbsolute = false) => {
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);
  const entries = await listFolderEntries(folderPath, 'dropboxFolderContentCount');
  return entries.length;
};

const findLatestFileInFolder = async (clientFolderSegment, isAbsolute, extensions, callerLabel) => {
  const files = await listFilesInFolder(clientFolderSegment, isAbsolute, extensions, callerLabel);
  return files.length === 0 ? null : files[0];
};

const findLatestPayrollFile = (clientFolderSegment, isAbsolute = false) =>
  findLatestFileInFolder(clientFolderSegment, isAbsolute, PAYROLL_FILE_EXTENSIONS, 'findLatestPayrollFile');

const listPayrollFiles = (clientFolderSegment, isAbsolute = false) =>
  listFilesInFolder(clientFolderSegment, isAbsolute, PAYROLL_FILE_EXTENSIONS, 'listPayrollFiles');

const downloadDropboxFileToLocal = async (dropboxFilePath, localFilePath) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);

  try {
    const response = await dbx.filesDownload({ path: dropboxFilePath });
    fs.writeFileSync(localFilePath, response.result.fileBinary, 'binary');
  } catch (error) {
    console.error(`downloadDropboxFileToLocal ERROR ("${dropboxFilePath}"): ${formatError(error)}`);
    throw error;
  }
};

const downloadDropboxFileBuffer = async (dropboxFilePath) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);

  try {
    const response = await dbx.filesDownload({ path: dropboxFilePath });
    return Buffer.from(response.result.fileBinary, 'binary');
  } catch (error) {
    console.error(`downloadDropboxFileBuffer ERROR ("${dropboxFilePath}"): ${formatError(error)}`);
    throw error;
  }
};

const uploadReportFile = async (clientFolderSegment, fileName, contentBuffer, isAbsolute = false) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = createDropboxClient(accessToken);
  const folderPath = await resolveDropboxFolderPath(clientFolderSegment, isAbsolute);
  const dropboxPath = `${folderPath}/${sanitizeForPath(fileName)}`;

  try {
    const response = await dbx.filesUpload({
      path: dropboxPath,
      contents: contentBuffer,
      mode: { '.tag': 'overwrite' },
    });
    return response.result.path_display;
  } catch (error) {
    console.error(`uploadReportFile ERROR ("${fileName}" to "${folderPath}"): ${formatError(error)}`);
    throw error;
  }
};

module.exports = {
  uploadFileToDropbox,
  ensureDropboxFolderExists,
  renameDropboxFolder,
  deleteDropboxFolder,
  getDropboxAccessToken,
  findLatestPayrollFile,
  listPayrollFiles,
  listAllFilesInFolder,
  dropboxFolderContentCount,
  downloadDropboxFileToLocal,
  downloadDropboxFileBuffer,
  uploadReportFile,
};
