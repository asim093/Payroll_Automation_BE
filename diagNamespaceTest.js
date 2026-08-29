require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const TEAM_FOLDER_SHARED_ID = '6325348304';

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  console.log('=== TEST A: list_folder("") with Dropbox-API-Path-Root = namespace_id mode, using shared_folder_id as namespace_id ===');
  const listResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_SHARED_ID }),
    },
    body: JSON.stringify({ path: '', limit: 50 }),
  });
  console.log(`Status: ${listResponse.status}`);
  const listData = await listResponse.json();
  if (listResponse.ok) {
    console.log(`Entries found: ${listData.entries.length}`);
    listData.entries.slice(0, 20).forEach((e) => console.log(` - [${e['.tag']}] ${e.name}`));
  } else {
    console.log(JSON.stringify(listData, null, 2));
  }

  console.log('\n=== TEST B: get_current_account -> root_namespace_id / home_namespace_id (for reference) ===');
  const acctResponse = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const acctData = await acctResponse.json();
  console.log(`Status: ${acctResponse.status}`);
  console.log('root_info:', JSON.stringify(acctData.root_info, null, 2));

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
