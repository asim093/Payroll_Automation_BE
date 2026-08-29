require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const FileLog = require('./models/FileLog');
const Client = require('./models/Client');
const { getDropboxAccessToken } = require('./services/dropboxService');

const run = async () => {
  await connectDB();

  console.log('=== STEP 5: .env DROPBOX_APP_KEY (masked) ===');
  const appKey = process.env.DROPBOX_APP_KEY || '';
  console.log(`DROPBOX_APP_KEY: ...${appKey.slice(-4)} (length: ${appKey.length})`);
  console.log(`DROPBOX_REFRESH_TOKEN present in .env? ${Boolean(process.env.DROPBOX_REFRESH_TOKEN)}`);

  console.log('\n=== STEP 3.1: get_current_account ===');
  const accessToken = await getDropboxAccessToken();
  const accountResponse = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const accountData = await accountResponse.json();
  console.log(`Status: ${accountResponse.status}`);
  console.log(`Account email: ${accountData.email}`);
  console.log(`Account name: ${accountData.name?.display_name}`);
  console.log(`Account type: ${JSON.stringify(accountData.account_type)}`);

  console.log('\n=== STEP 3.2: list_folder(path: "") - root ===');
  const listResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '', recursive: false }),
  });
  const listData = await listResponse.json();
  console.log(`Status: ${listResponse.status}`);
  if (listResponse.ok) {
    console.log(`Top-level entries count: ${listData.entries.length}`);
    listData.entries.forEach((entry) => console.log(`  "${entry.name}" (${entry['.tag']})`));
  } else {
    console.log(JSON.stringify(listData));
  }

  console.log('\n=== STEP 4: Most recent FileLog for Imran (ShareFile source) ===');
  const imran = await Client.findOne({ name: 'Imran' });
  const recentFileLog = await FileLog.findOne({ clientId: imran._id }).sort({ createdAt: -1 });
  console.log(`FileLog _id: ${recentFileLog._id}`);
  console.log(`originalName: ${recentFileLog.originalName}`);
  console.log(`source: ${recentFileLog.source}`);
  console.log(`status: ${recentFileLog.status}`);
  console.log(`destinationPath: "${recentFileLog.destinationPath}"`);
  console.log(`destination: ${recentFileLog.destination}`);
  console.log(`processedAt: ${recentFileLog.processedAt}`);
  console.log(`createdAt: ${recentFileLog.createdAt}`);

  console.log('\n=== STEP 3.3: get_metadata for that exact destinationPath ===');
  const metaResponse = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: recentFileLog.destinationPath }),
  });
  const metaData = await metaResponse.json();
  console.log(`Status: ${metaResponse.status}`);
  console.log(JSON.stringify(metaData, null, 2));

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  mongoose.connection.close();
});
