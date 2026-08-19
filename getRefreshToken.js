/**
 * ONE-TIME MANUAL LOGIN SCRIPT
 * ------------------------------------------------------------------------
 * Runs the Authorization Code Flow (MSAL PublicClientApplication) against
 * "common" so a personal Microsoft account (e.g. outlook.com) can log in —
 * this is separate from, and parallel to, the client-credentials flow in
 * test-auth.js / graphService.js, which only works for org accounts.
 *
 * Run this with `node getRefreshToken.js`, then open the printed URL in a
 * browser and log in manually. This script starts a local server to catch
 * the redirect, exchanges the auth code for tokens, and prints the refresh
 * token so it can be copied into .env as DELEGATED_REFRESH_TOKEN once.
 * After that, delegatedAuthService.js uses the saved refresh token to get
 * new access tokens without any further manual login.
 * ------------------------------------------------------------------------
 */
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { PublicClientApplication } = require('@azure/msal-node');

// MailboxSettings.ReadWrite is needed for graphService.ensureCategoryExists()
// (GET/POST /outlook/masterCategories) — Mail.Read/Mail.ReadWrite alone
// cover messages themselves but not mailbox-level settings like categories.
const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];

const redirectUri = process.env.REDIRECT_URI;
if (!redirectUri) {
  console.error(
    'REDIRECT_URI is not set in .env (e.g. http://localhost:3000/redirect). Set it before running this script.'
  );
  process.exit(1);
}

const clientId = process.env.CLIENT_ID;
if (!clientId) {
  console.error('CLIENT_ID is not set in .env.');
  process.exit(1);
}

const pca = new PublicClientApplication({
  auth: {
    clientId,
    // "common" (not the org's TENANT_ID) so personal Microsoft accounts
    // can authenticate too, not just accounts in our own tenant.
    authority: 'https://login.microsoftonline.com/common',
  },
});

const redirectUrlObj = new URL(redirectUri);
const PORT = Number(redirectUrlObj.port) || 3000;
const CALLBACK_PATH = redirectUrlObj.pathname;

/**
 * acquireTokenByCode()'s return value never includes the refresh token
 * directly (MSAL manages it internally) — it's only ever written into the
 * token cache, so for this one-time manual flow we read it back out of the
 * serialized cache ourselves.
 */
function extractRefreshTokenFromCache(client) {
  const cache = JSON.parse(client.getTokenCache().serialize());
  const refreshTokens = cache.RefreshToken || {};
  const firstKey = Object.keys(refreshTokens)[0];
  return firstKey ? refreshTokens[firstKey].secret : null;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (requestUrl.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const errorParam = requestUrl.searchParams.get('error');
  if (errorParam) {
    const errorDescription = requestUrl.searchParams.get('error_description');
    console.error(`\nLogin failed: ${errorParam} - ${errorDescription}`);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Login failed - check the terminal for details. You can close this tab.');
    server.close(() => process.exit(1));
    return;
  }

  const code = requestUrl.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No authorization code received.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Login successful! Check the terminal for the refresh token. You can close this tab.');

  try {
    const tokenResponse = await pca.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri,
    });

    console.log(`\nSUCCESS! Logged in as: ${tokenResponse.account?.username}`);

    const refreshToken = extractRefreshTokenFromCache(pca);
    if (refreshToken) {
      console.log('\n--- Refresh Token ---');
      console.log(refreshToken);
      console.log('---------------------');
      console.log(
        '\nIs token ko .env mein DELEGATED_REFRESH_TOKEN naam se save karein, kisi ke sath share na karein.'
      );
    } else {
      console.error(
        '\nAccess token received, but no refresh token was found in the cache — confirm the "offline_access" scope was granted.'
      );
    }
  } catch (error) {
    console.error('\nFailed to exchange authorization code for tokens:', error.message);
  } finally {
    server.close(() => {
      console.log('\nLocal server stopped.');
    });
  }
});

server.listen(PORT, async () => {
  try {
    const authCodeUrl = await pca.getAuthCodeUrl({ scopes: SCOPES, redirectUri });

    console.log(`Local redirect-handler server listening on port ${PORT}.`);
    console.log('\nOpen this URL in your browser and log in with a personal Microsoft account:\n');
    console.log(authCodeUrl);
    console.log('\nWaiting for redirect...');
  } catch (error) {
    console.error('Failed to build the authorization URL:', error.message);
    server.close(() => process.exit(1));
  }
});
