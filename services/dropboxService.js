const { Dropbox } = require('dropbox');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');
const { formatError } = require('../utils/formatError');

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
 * Upload a file to Dropbox at
 * /WOTC/{clientName}/Payroll Files/{timestamp}_{fileName}. The timestamp
 * prefix (see generateUniqueFilename) stops two attachments with the same
 * original name from overwriting each other — without it, "overwrite" mode
 * below would silently replace an earlier file that happened to share a name.
 * Returns the uploaded file's Dropbox path on success.
 *
 * @param {string} clientName
 * @param {string} fileName
 * @param {Buffer} contentBuffer
 * @param {Date} [referenceDate] - pass the same Date used for other
 *   destinations (e.g. local disk) of this same attachment, so both end up
 *   with an identical unique filename.
 */
const uploadFileToDropbox = async (clientName, fileName, contentBuffer, referenceDate) => {
  const accessToken = await getDropboxAccessToken();
  const dbx = new Dropbox({ accessToken, fetch });

  const safeClientName = sanitizeForPath(clientName);
  const uniqueName = generateUniqueFilename(fileName, referenceDate);
  const safeFileName = sanitizeForPath(uniqueName);
  const dropboxPath = `/WOTC/${safeClientName}/Payroll Files/${safeFileName}`;

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
      `uploadFileToDropbox ERROR: could not upload "${fileName}" for client "${clientName}" — status: ${status} — ${message}`
    );
    throw error;
  }
};

module.exports = { uploadFileToDropbox, getDropboxAccessToken };
