require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  console.log('=== sharing/list_folder_members for shared_folder_id 6325348304 ===');
  const response = await fetch('https://api.dropboxapi.com/2/sharing/list_folder_members', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_folder_id: '6325348304' }),
  });
  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));

  console.log('\n=== sharing/get_folder_metadata for shared_folder_id 6325348304 (top-level info) ===');
  const metaResponse = await fetch('https://api.dropboxapi.com/2/sharing/get_folder_metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_folder_id: '6325348304' }),
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
