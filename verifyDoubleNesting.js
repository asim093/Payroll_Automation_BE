require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const listFolder = async (accessToken, path) => {
  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Dropbox-API-Path-Root': namespaceHeader,
    },
    body: JSON.stringify({ path }),
  });
  return { status: response.status, data: await response.json() };
};

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  console.log('=== Team-folder root ("") - full listing, checking for a literal "WOTC" subfolder ===');
  const root = await listFolder(accessToken, '');
  console.log(`Status: ${root.status} | total entries: ${root.data.entries?.length} | has_more: ${root.data.has_more}`);
  const wotcSubfolder = root.data.entries?.find((e) => e.name.toLowerCase() === 'wotc');
  console.log('Literal "WOTC" subfolder at namespace root:', wotcSubfolder ? JSON.stringify(wotcSubfolder) : 'NOT FOUND');
  const imranAtRoot = root.data.entries?.find((e) => e.name.toLowerCase() === 'imran');
  console.log('"Imran" directly at namespace root:', imranAtRoot ? JSON.stringify(imranAtRoot) : 'NOT FOUND');

  console.log('\n=== Contents of "/WOTC" (the subfolder) inside the team folder ===');
  const wotcContents = await listFolder(accessToken, '/WOTC');
  console.log(`Status: ${wotcContents.status}`);
  if (wotcContents.status === 200) {
    console.log(`Entries inside /WOTC: ${wotcContents.data.entries.length}`);
    wotcContents.data.entries.forEach((e) => console.log(` - [${e['.tag']}] ${e.name}`));
  } else {
    console.log(JSON.stringify(wotcContents.data));
  }

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
