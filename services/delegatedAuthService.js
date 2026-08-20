const { PublicClientApplication } = require('@azure/msal-node');


const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];

const pca = new PublicClientApplication({
  auth: {
    clientId: process.env.DELEGATED_CLIENT_ID || process.env.CLIENT_ID,
    authority: 'https://login.microsoftonline.com/common',
  },
});


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
