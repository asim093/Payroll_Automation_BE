const { PublicClientApplication } = require('@azure/msal-node');

// Must match getRefreshToken.js's SCOPES — the refresh token was issued for
// this exact scope set, and acquireTokenByRefreshToken() needs to request
// the same ones to get an access token that actually carries
// MailboxSettings.ReadWrite (needed for ensureCategoryExists()).
const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];

const pca = new PublicClientApplication({
  auth: {
    // Same app registration as CLIENT_ID; DELEGATED_CLIENT_ID is its own
    // variable because this is a separate, parallel auth flow.
    clientId: process.env.DELEGATED_CLIENT_ID || process.env.CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
  },
});

/**
 * Exchanges the long-lived DELEGATED_REFRESH_TOKEN (obtained once via
 * getRefreshToken.js) for a fresh access token, using MSAL's
 * refresh-token flow. This is the delegated-permissions counterpart to
 * graphService.js's client-credentials getAccessToken() — use this one
 * when calling Graph on behalf of a personal Microsoft account.
 */
const getAccessTokenFromRefreshToken = async () => {
  const refreshToken = process.env.DELEGATED_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'DELEGATED_REFRESH_TOKEN is not set in .env — run `node getRefreshToken.js` once to obtain it.'
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
