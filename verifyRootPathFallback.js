require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Settings = require('./models/Settings');
const {
  getDropboxAccessToken,
  uploadFileToDropbox,
  deleteDropboxItemByPath,
} = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const getMetadata = async (accessToken, path, useHeader) => {
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

  console.log('=== STEP 3: Settings.dropboxRootPath WAPAS "WOTC" set karo ===');
  const settings = await Settings.findOne();
  settings.dropboxRootPath = 'WOTC';
  await settings.save();
  const confirmSettings = await Settings.findOne();
  console.log(`Settings.dropboxRootPath now: "${confirmSettings.dropboxRootPath}"`);

  console.log('\n=== Test: naya dummy upload, namespace-mode ON, Settings me "WOTC" likha hone ke bawajood ===');
  const path1 = await uploadFileToDropbox('Imran', '_rootpath_ignore_test.txt', Buffer.from('namespace-mode test - safe to ignore/delete'), new Date());
  console.log(`uploadFileToDropbox() returned: ${path1}`);
  const isDirect = /^\/Imran\//i.test(path1);
  console.log(`Directly under "/Imran" (no WOTC nesting), even though Settings says "WOTC": ${isDirect}`);
  const confirm1 = await getMetadata(accessToken, path1, true);
  console.log(`get_metadata confirm: status ${confirm1.status}`);
  await deleteDropboxItemByPath(path1);
  console.log('Cleaned up.');

  console.log('\n=== STEP 4: Fallback test - DROPBOX_TEAM_FOLDER_NAMESPACE_ID temporarily unset (in-process only) ===');
  delete process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
  delete require.cache[require.resolve('./services/dropboxService')];
  const dropboxServiceNoNamespace = require('./services/dropboxService');
  const path2 = await dropboxServiceNoNamespace.uploadFileToDropbox('Imran', '_rootpath_fallback_test.txt', Buffer.from('fallback test - safe to ignore/delete'), new Date());
  console.log(`uploadFileToDropbox() returned (namespace_id unset): ${path2}`);
  const isPrefixed = /^\/WOTC\/Imran\//i.test(path2);
  console.log(`Correctly prefixed with "/WOTC/Imran/" when namespace_id is NOT set: ${isPrefixed}`);

  const confirm2InPersonalRoot = await getMetadata(accessToken, path2, false);
  console.log(`get_metadata (personal root, no header) confirm: status ${confirm2InPersonalRoot.status}`);
  await dropboxServiceNoNamespace.deleteDropboxItemByPath(path2);
  console.log('Cleaned up (personal-root test file, deleted without namespace header).');

  process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID = TEAM_FOLDER_NAMESPACE_ID;

  await mongoose.connection.close();
};
run().catch((err) => { console.error('FATAL:', err.message); mongoose.connection.close(); });
