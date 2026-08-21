const OAuthCredential = require('../models/OAuthCredential');

const PROVIDER_KEY = 'sharefile';

const getSubdomain = () => {
  const subdomain = process.env.SHAREFILE_SUBDOMAIN;
  if (!subdomain) {
    throw new Error('SHAREFILE_SUBDOMAIN is not set in .env.');
  }
  return subdomain;
};

const getCallbackUrl = () => {
  const url = process.env.SHAREFILE_OAUTH_CALLBACK_URL;
  if (!url) {
    throw new Error(
      'SHAREFILE_OAUTH_CALLBACK_URL is not set in .env — set it to this service\'s own public URL + /oauth/sharefile/callback, and register the EXACT same URL as the Redirect URI on the app in the ShareFile API App Console (replacing the default secure.sharefile.com/oauth/oauthcomplete.aspx one).'
    );
  }
  return url;
};

const getClientCredentials = () => {
  const { SHAREFILE_CLIENT_ID, SHAREFILE_CLIENT_SECRET } = process.env;
  if (!SHAREFILE_CLIENT_ID || !SHAREFILE_CLIENT_SECRET) {
    throw new Error('SHAREFILE_CLIENT_ID / SHAREFILE_CLIENT_SECRET are not set in .env.');
  }
  return { clientId: SHAREFILE_CLIENT_ID, clientSecret: SHAREFILE_CLIENT_SECRET };
};

const buildAuthorizationUrl = () => {
  const { clientId } = getClientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getCallbackUrl(),
    response_type: 'code',
  });
  return `https://${getSubdomain()}.sharefile.com/oauth/authorize?${params.toString()}`;
};

const saveRefreshToken = async (refreshToken) => {
  await OAuthCredential.findOneAndUpdate({ provider: PROVIDER_KEY }, { refreshToken }, { upsert: true });
};

const completeLogin = async (code) => {
  const { clientId, clientSecret } = getClientCredentials();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getCallbackUrl(),
  });

  const response = await fetch(`https://${getSubdomain()}.sharefile.com/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok || !data.refresh_token) {
    console.error(`shareFileOAuthSetupService.completeLogin ERROR: ${response.status} ${JSON.stringify(data)}`);
    throw new Error(data.error_description || 'ShareFile did not return a refresh token for this login.');
  }

  await saveRefreshToken(data.refresh_token);
  // ShareFile's token response doesn't include the account's email/name
  // directly (unlike Microsoft's ID token) - nothing meaningful to show
  // here, the result page just confirms success generically.
  return { loggedInAs: null };
};

// Exchanges a stored refresh token for a fresh access token - called on
// every ShareFile API operation (see sharefileService.js's
// getShareFileAccessToken()). Some OAuth providers rotate the refresh
// token on every use; to stay correct either way, whatever refresh_token
// comes back (rotated or unchanged) is always re-saved.
// @returns { accessToken, subdomain } - same shape the old password-grant
//   path returned, so sharefileService.js's callers don't need to change.
const refreshAccessToken = async (refreshToken) => {
  const { clientId, clientSecret } = getClientCredentials();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(`https://${getSubdomain()}.sharefile.com/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error(`shareFileOAuthSetupService.refreshAccessToken ERROR: ${response.status} ${JSON.stringify(data)}`);
    throw new Error(data.error_description || `ShareFile refresh-token exchange failed (${response.status}).`);
  }

  if (data.refresh_token) {
    await saveRefreshToken(data.refresh_token);
  }

  return { accessToken: data.access_token, subdomain: data.subdomain || getSubdomain() };
};

module.exports = { PROVIDER_KEY, buildAuthorizationUrl, completeLogin, refreshAccessToken };
