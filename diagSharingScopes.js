require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  console.log('=== STEP 1: Try sharing/list_folders (reveals if sharing.read scope is missing) ===');
  const listFoldersResponse = await fetch('https://api.dropboxapi.com/2/sharing/list_folders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100 }),
  });
  console.log(`Status: ${listFoldersResponse.status}`);
  const listFoldersData = await listFoldersResponse.json();
  console.log(JSON.stringify(listFoldersData, null, 2));

  console.log('\n=== STEP 3: get_metadata for /WOTC with sharing info ===');
  const metaResponse = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/WOTC', include_has_explicit_shared_members: true }),
  });
  console.log(`Status: ${metaResponse.status}`);
  const metaData = await metaResponse.json();
  console.log(JSON.stringify(metaData, null, 2));

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
