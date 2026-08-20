const { PublicClientApplication } = require('@azure/msal-node');
const OAuthCredential = require('../models/OAuthCredential');
const { PROVIDER_KEY } = require('./microsoftOAuthSetupService');


const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];

const pca = new PublicClientApplication({
  auth: {
    clientId: process.env.DELEGATED_CLIENT_ID || process.env.CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
  },
});

// PHASE-UI-13 — DB-stored token (from the web-hosted login flow - see
// microsoftOAuthSetupService.js) wins if present, since it represents the
// most recently (re-)authorized login; falls back to the .env value for
// anyone still using the local getRefreshToken.js script. Checked fresh on
// every call (not cached) so a re-login while the app is already running
// takes effect on the very next call, no restart needed.
const resolveRefreshToken = async () => {
  const stored = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
  return stored?.refreshToken || process.env.DELEGATED_REFRESH_TOKEN;
};

const getAccessTokenFromRefreshToken = async () => {
  const refreshToken = await resolveRefreshToken();
  if (!refreshToken) {
    throw new Error(
      'No delegated refresh token available — either run `node getRefreshToken.js` once locally and set DELEGATED_REFRESH_TOKEN in .env, or complete the hosted login at /oauth/microsoft/start.'
    );
  }

  try {
    const response = await pca.acquireTokenByRefreshToken({
      refreshToken,
      scopes: SCOPES,
    });
    return response.accessToken;
  } catch (error) {
    console.error(
      `getAccessTokenFromRefreshToken ERROR: ${error.errorCode || 'unknown'} - ${error.message}`
    );
    throw error;
  }
};

module.exports = { getAccessTokenFromRefreshToken };
