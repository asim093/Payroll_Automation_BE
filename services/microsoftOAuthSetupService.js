const { PublicClientApplication } = require('@azure/msal-node');
const OAuthCredential = require('../models/OAuthCredential');


const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];
const PROVIDER_KEY = 'microsoft-delegated';

const getCallbackUrl = () => {
  const url = process.env.MICROSOFT_OAUTH_CALLBACK_URL;
  if (!url) {
    throw new Error(
      'MICROSOFT_OAUTH_CALLBACK_URL is not set in .env — set it to this service\'s own public URL + /oauth/microsoft/callback, and register the EXACT same URL as a Redirect URI on the Azure app registration.'
    );
  }
  return url;
};

const getClientApp = () => {
  const clientId = process.env.DELEGATED_CLIENT_ID || process.env.CLIENT_ID;
  if (!clientId) {
    throw new Error('DELEGATED_CLIENT_ID (or CLIENT_ID) is not set in .env.');
  }
  return new PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/common',
    },
  });
};

const buildAuthorizationUrl = async () => {
  const pca = getClientApp();
  return pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: getCallbackUrl(),
    prompt: 'select_account',
  });
};


const extractRefreshTokenFromCache = (client) => {
  const cache = JSON.parse(client.getTokenCache().serialize());
  const refreshTokens = cache.RefreshToken || {};
  const firstKey = Object.keys(refreshTokens)[0];
  return firstKey ? refreshTokens[firstKey].secret : null;
};


const completeLogin = async (code) => {
  const pca = getClientApp();
  const tokenResponse = await pca.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: getCallbackUrl(),
  });

  const refreshToken = extractRefreshTokenFromCache(pca);
  if (!refreshToken) {
    throw new Error('Login succeeded but no refresh token was issued - confirm "offline_access" was granted.');
  }

  const loggedInAs = tokenResponse.account?.username || null;

  await OAuthCredential.findOneAndUpdate(
    { provider: PROVIDER_KEY },
    { refreshToken, loggedInAs },
    { upsert: true }
  );

  return { loggedInAs };
};

module.exports = { buildAuthorizationUrl, completeLogin, PROVIDER_KEY };
