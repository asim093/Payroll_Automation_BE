require('dotenv').config();
const readline = require('readline');

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET are not set in .env.');
  process.exit(1);
}

const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline`;

console.log('Open this URL in your browser, log in, and paste the authorization code you receive here in the terminal:\n');
console.log(authUrl);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the authorization code: ', async (rawCode) => {
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
      '\nSave this in .env as DROPBOX_REFRESH_TOKEN. Do not share it with anyone.'
    );
  } catch (error) {
    console.error('\nError exchanging code for tokens:', error.message);
    process.exit(1);
  }
});
