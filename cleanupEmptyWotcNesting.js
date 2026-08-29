require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken, deleteDropboxItemByPath } = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const listFolder = async (accessToken, path) => {
  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Dropbox-API-Path-Root': namespaceHeader },
    body: JSON.stringify({ path }),
  });
  return response.json();
};

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  const wotcImranContents = await listFolder(accessToken, '/WOTC/Imran');
  console.log(`"/WOTC/Imran" entries: ${wotcImranContents.entries?.length}`);
  if (wotcImranContents.entries?.length === 0) {
    await deleteDropboxItemByPath('/WOTC/Imran');
    console.log('Deleted empty "/WOTC/Imran".');
  } else {
    console.log('Not empty, not deleting:', wotcImranContents.entries);
  }

  const wotcContents = await listFolder(accessToken, '/WOTC');
  console.log(`"/WOTC" entries now: ${wotcContents.entries?.length}`);
  if (wotcContents.entries?.length === 0) {
    await deleteDropboxItemByPath('/WOTC');
    console.log('Deleted empty "/WOTC" subfolder.');
  } else {
    console.log('Not empty, not deleting:', wotcContents.entries);
  }

  await mongoose.connection.close();
};
run().catch((err) => { console.error('FATAL:', err.message); mongoose.connection.close(); });
