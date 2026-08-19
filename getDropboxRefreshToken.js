/**
 * ONE-TIME MANUAL LOGIN SCRIPT
 * ------------------------------------------------------------------------
 * Gets a long-lived Dropbox refresh token (via the "offline access" OAuth2
 * flow) so uploadFileToDropbox() never needs a manually-pasted short-lived
 * access token again — see dropboxService.getDropboxAccessToken(), which
 * exchanges this refresh token for a fresh access token automatically on
 * every call.
 *
 * Run with `node getDropboxRefreshToken.js`, open the printed URL in a
 * browser, log in, and paste the authorization code Dropbox shows you back
 * into this terminal. No redirect URI/local server needed — Dropbox's
 * "offline access" flow without a redirect_uri just displays the code on
 * their own page for manual copy-paste.
 * ------------------------------------------------------------------------
 */
require('dotenv').config();
const readline = require('readline');

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET are not set in .env.');
  process.exit(1);
}

const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline`;

console.log('Is URL ko browser mein kholo, login karo, aur jo authorization-code milega, use yahan terminal mein paste karo:\n');
console.log(authUrl);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Authorization code paste karein: ', async (rawCode) => {
  rl.close();
  const code = rawCode.trim();

  if (!code) {
    console.error('No code received — nothing was pasted.');
    process.exit(1);
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    });

    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`\nToken exchange failed (${response.status}): ${errorBody}`);
      process.exit(1);
    }

    const data = await response.json();
    if (!data.refresh_token) {
      console.error('\nNo refresh_token found in the response:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log('\n--- Refresh Token ---');
    console.log(data.refresh_token);
    console.log('---------------------');
    console.log(
      '\n.env mein DROPBOX_REFRESH_TOKEN naam se save karein, kisi ke sath share na karein.'
    );
  } catch (error) {
    console.error('\nError exchanging code for tokens:', error.message);
    process.exit(1);
  }
});
