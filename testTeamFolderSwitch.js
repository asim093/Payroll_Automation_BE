require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const {
  getDropboxAccessToken,
  uploadFileToDropbox,
  ensureDropboxFolderExists,
  deleteDropboxFolder,
  deleteDropboxItemByPath,
} = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const getMetadata = async (accessToken, path, useNamespaceHeader) => {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (useNamespaceHeader) headers['Dropbox-API-Path-Root'] = namespaceHeader;
  const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path }),
  });
  return { status: response.status, data: await response.json() };
};

const run = async () => {
  await connectDB();
  console.log(`DROPBOX_TEAM_FOLDER_NAMESPACE_ID = ${TEAM_FOLDER_NAMESPACE_ID}\n`);

  console.log('=== STEP 3: Raw namespace-header upload + verify + cleanup, in "!Marcels Test" ===');
  const accessToken = await getDropboxAccessToken();
  const testPath = `/!Marcels Test/_namespace_switch_test_${Date.now()}.txt`;

  const uploadResponse = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Path-Root': namespaceHeader,
      'Dropbox-API-Arg': JSON.stringify({ path: testPath, mode: { '.tag': 'add' }, autorename: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from('namespace switch test file - safe to ignore/delete'),
  });
  const uploadData = await uploadResponse.json();
  console.log(`Upload status: ${uploadResponse.status} -> path_display: ${uploadData.path_display}`);

  const foundInTeamFolder = await getMetadata(accessToken, testPath, true);
  console.log(`get_metadata WITH namespace header -> status ${foundInTeamFolder.status} (expect 200/found)`);

  const foundInPersonalRoot = await getMetadata(accessToken, testPath, false);
  console.log(`get_metadata WITHOUT header (personal root) -> status ${foundInPersonalRoot.status} (expect 409/not_found)`);

  const deleteResponse = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Path-Root': namespaceHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: uploadData.path_lower }),
  });
  console.log(`Cleanup delete status: ${deleteResponse.status}`);

  console.log('\n=== STEP 4a: Does "/WOTC/Imran" already exist inside the team folder? ===');
  const imranCheck = await getMetadata(accessToken, '/WOTC/Imran', true);
  console.log(`Status: ${imranCheck.status}`, imranCheck.status === 200 ? `(found, tag: ${imranCheck.data['.tag']})` : JSON.stringify(imranCheck.data));

  console.log('\n=== STEP 4b: Real uploadFileToDropbox() (production function) for client "Imran" ===');
  const uploadedPath = await uploadFileToDropbox('Imran', '_namespace_switch_real_flow_test.txt', Buffer.from('real flow test - safe to ignore/delete'), new Date());
  console.log(`uploadFileToDropbox() returned path: ${uploadedPath}`);

  const landedInTeamFolder = await getMetadata(accessToken, uploadedPath, true);
  console.log(`Confirm via get_metadata WITH namespace header -> status ${landedInTeamFolder.status} (expect 200)`);

  const notInPersonalRoot = await getMetadata(accessToken, uploadedPath, false);
  console.log(`Confirm via get_metadata WITHOUT header (personal root) -> status ${notInPersonalRoot.status} (expect 409/not_found)`);

  await deleteDropboxItemByPath(uploadedPath);
  console.log('Cleaned up the test file from /WOTC/Imran.');

  console.log('\n=== STEP 4c: ensureDropboxFolderExists() auto-create test, disposable fake client folder ===');
  const fakeSegment = `ZZ_NamespaceSwitchTest_${Date.now()}`;
  const createResult = await ensureDropboxFolderExists(fakeSegment);
  console.log('ensureDropboxFolderExists() result:', createResult);

  const createdCheck = await getMetadata(accessToken, createResult.path, true);
  console.log(`Confirm folder exists in TEAM folder -> status ${createdCheck.status} (expect 200)`);

  const deleteFolderResult = await deleteDropboxFolder(fakeSegment);
  console.log('Cleanup deleteDropboxFolder() result:', deleteFolderResult);

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
