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


const resolveRefreshToken = async () => {
  const stored = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
  return stored?.refreshToken || process.env.DELEGATED_REFRESH_TOKEN;
};


const resolveMailboxEmail = async () => {
  const stored = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
  return stored?.loggedInAs || process.env.DELEGATED_MAILBOX_EMAIL || null;
};


const isDelegatedConfigAvailable = async () => {
  if (!process.env.DELEGATED_CLIENT_ID) return false;
  const stored = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
  const hasRefreshToken = Boolean(stored?.refreshToken || process.env.DELEGATED_REFRESH_TOKEN);
  const hasMailboxEmail = Boolean(stored?.loggedInAs || process.env.DELEGATED_MAILBOX_EMAIL);
  return hasRefreshToken && hasMailboxEmail;
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

module.exports = { getAccessTokenFromRefreshToken, resolveMailboxEmail, isDelegatedConfigAvailable };
