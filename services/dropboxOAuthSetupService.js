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
  return { loggedInAs: null };
};

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

  return { accessToken: data.access_token, expiresIn: data.expires_in };
};

module.exports = { PROVIDER_KEY, buildAuthorizationUrl, completeLogin, refreshAccessToken };
