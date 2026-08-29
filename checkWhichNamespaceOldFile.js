require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });
const path = '/WOTC/Imran/2026-08-29_073903_Screenshot 2026-07-23 151317.png';

const getMetadata = async (accessToken, useHeader) => {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (useHeader) headers['Dropbox-API-Path-Root'] = namespaceHeader;
  const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST', headers, body: JSON.stringify({ path }),
  });
  return { status: response.status, data: await response.json() };
};

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();
  const inTeamFolder = await getMetadata(accessToken, true);
  console.log(`WITH namespace header (team-folder) -> status ${inTeamFolder.status}`);
  const inPersonalRoot = await getMetadata(accessToken, false);
  console.log(`WITHOUT header (personal root) -> status ${inPersonalRoot.status}`);
  await mongoose.connection.close();
};
run().catch((err) => { console.error('FATAL:', err.message); mongoose.connection.close(); });
