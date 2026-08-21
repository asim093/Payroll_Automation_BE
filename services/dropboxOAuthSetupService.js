/**
 * PHASE-UI-15 — web-hosted Dropbox login flow, mirroring
 * microsoftOAuthSetupService.js / shareFileOAuthSetupService.js's exact
 * shape/pattern for consistency (same "open a link, log in, click Allow"
 * experience across all three integrations).
 *
 * This does NOT replace getDropboxRefreshToken.js (the local manual-copy-
 * paste script still works and is untouched) - it's an additional, hosted
 * alternative for whoever owns the Dropbox account when they aren't sitting
 * at a machine that can run a local script. Refresh tokens are saved to
 * MongoDB (OAuthCredential, provider: 'dropbox') - shared by the web
 * service and both cron jobs, no per-service env-var copying needed.
 */
const OAuthCredential = require('../models/OAuthCredential');

const PROVIDER_KEY = 'dropbox';

const getCallbackUrl = () => {
  const url = process.env.DROPBOX_OAUTH_CALLBACK_URL;
  if (!url) {
    throw new Error(
      'DROPBOX_OAUTH_CALLBACK_URL is not set in .env — set it to this service\'s own public URL + /oauth/dropbox/callback, and register the EXACT same URL as a Redirect URI on the app in the Dropbox App Console.'
    );
  }
  return url;
};

const getClientCredentials = () => {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET } = process.env;
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET) {
    throw new Error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET are not set in .env.');
  }
  return { appKey: DROPBOX_APP_KEY, appSecret: DROPBOX_APP_SECRET };
};

// @returns the URL to send the browser to for login. token_access_type is
// what makes Dropbox issue a long-lived refresh token instead of just a
// short-lived access token - same param getDropboxRefreshToken.js uses,
// just paired with a real redirect_uri here instead of the manual-copy-paste
// no-redirect variant.
const buildAuthorizationUrl = () => {
  const { appKey } = getClientCredentials();
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    redirect_uri: getCallbackUrl(),
    token_access_type: 'offline',
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
};

const saveRefreshToken = async (refreshToken) => {
  await OAuthCredential.findOneAndUpdate({ provider: PROVIDER_KEY }, { refreshToken }, { upsert: true });
};

// Exchanges the authorization `code` Dropbox just redirected back with.
// redirect_uri must be repeated here (matching the /authorize call) - same
// OAuth2 rule ShareFile's completeLogin() follows.
const completeLogin = async (code) => {
  const { appKey, appSecret } = getClientCredentials();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    client_secret: appSecret,
    redirect_uri: getCallbackUrl(),
  });

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok || !data.refresh_token) {
    console.error(`dropboxOAuthSetupService.completeLogin ERROR: ${response.status} ${JSON.stringify(data)}`);
    throw new Error(data.error_summary || data.error_description || 'Dropbox did not return a refresh token for this login.');
  }

  await saveRefreshToken(data.refresh_token);
  // Dropbox's token response doesn't include the account's email/name
  // directly - nothing meaningful to show here, the result page just
  // confirms success generically (same as ShareFile's callback).
  return { loggedInAs: null };
};

// Exchanges a stored refresh token for a fresh access token - called on
// every Dropbox API operation (see dropboxService.js's getDropboxAccessToken()).
// Dropbox refresh tokens don't rotate/expire on use, but the response is
// checked defensively anyway in case that ever changes.
// @returns { accessToken }
const refreshAccessToken = async (refreshToken) => {
  const { appKey, appSecret } = getClientCredentials();
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

  const data = await response.json();
  if (!response.ok) {
    console.error(`dropboxOAuthSetupService.refreshAccessToken ERROR: ${response.status} ${JSON.stringify(data)}`);
    throw new Error(data.error_summary || data.error_description || `Dropbox token refresh failed (${response.status}).`);
  }

  if (data.refresh_token) {
    await saveRefreshToken(data.refresh_token);
  }

  return { accessToken: data.access_token };
};

module.exports = { PROVIDER_KEY, buildAuthorizationUrl, completeLogin, refreshAccessToken };
