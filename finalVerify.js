require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const getMetadata = async (accessToken, path) => {
  const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Dropbox-API-Path-Root': namespaceHeader },
    body: JSON.stringify({ path }),
  });
  return { status: response.status, data: await response.json() };
};

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  const imranFinal = await getMetadata(accessToken, '/Imran/2026-08-29_153013_Screenshot 2026-07-24 103155.png');
  console.log(`Migrated file at "/Imran/...": status ${imranFinal.status}`);

  const wotcGone = await getMetadata(accessToken, '/WOTC');
  console.log(`"/WOTC" subfolder gone: status ${wotcGone.status} (expect 409/not_found)`);

  await mongoose.connection.close();
};
run().catch((err) => { console.error('FATAL:', err.message); mongoose.connection.close(); });
