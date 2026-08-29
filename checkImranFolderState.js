require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Path-Root': namespaceHeader,
    },
    body: JSON.stringify({ path: '/WOTC/Imran' }),
  });
  console.log(`Status: ${response.status}`);
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
