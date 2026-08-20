/**
 * PHASE-UI-13 — web-hosted version of getRefreshToken.js's Authorization
 * Code flow, for exactly the case that local script can't handle: the
 * person who actually needs to log in (the client, their real mailbox
 * owner) isn't sitting at the machine running the script. getRefreshToken.js
 * starts its own local server and needs Microsoft to redirect back to
 * localhost - only reachable if that browser is on the same machine.
 *
 * This does the identical MSAL exchange, but the "local server" is just a
 * route on the already-deployed, publicly-reachable web service (see
 * controllers/oauthController.js) - so the redirect works from anywhere.
 * The resulting refresh token is saved to MongoDB (OAuthCredential) instead
 * of printed to a terminal for manual copy-paste into .env - see
 * delegatedAuthService.js, which now checks there first.
 */
const { PublicClientApplication } = require('@azure/msal-node');
const OAuthCredential = require('../models/OAuthCredential');

// Same scopes as getRefreshToken.js - MailboxSettings.ReadWrite is needed
// for graphService.ensureCategoryExists(), Mail.Read/Mail.ReadWrite alone
// don't cover mailbox-level settings like categories.
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
      // "common" (not the org's TENANT_ID) so personal Microsoft accounts
      // can authenticate too, not just accounts in our own tenant - same
      // as getRefreshToken.js.
      authority: 'https://login.microsoftonline.com/common',
    },
  });
};

// @returns the URL to send the browser to for login.
const buildAuthorizationUrl = async () => {
  const pca = getClientApp();
  return pca.getAuthCodeUrl({ scopes: SCOPES, redirectUri: getCallbackUrl() });
};

/**
 * acquireTokenByCode()'s return value never includes the refresh token
 * directly (MSAL manages it internally) - it's only ever written into the
 * token cache, so we read it back out of the serialized cache ourselves.
 * Identical trick to getRefreshToken.js.
 */
const extractRefreshTokenFromCache = (client) => {
  const cache = JSON.parse(client.getTokenCache().serialize());
  const refreshTokens = cache.RefreshToken || {};
  const firstKey = Object.keys(refreshTokens)[0];
  return firstKey ? refreshTokens[firstKey].secret : null;
};

// Exchanges the authorization `code` Microsoft just redirected back with,
// and persists the resulting refresh token to MongoDB.
// @returns { loggedInAs }
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
