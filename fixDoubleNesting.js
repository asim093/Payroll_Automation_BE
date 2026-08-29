require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Settings = require('./models/Settings');
const {
  getDropboxAccessToken,
  uploadFileToDropbox,
  moveDropboxItemToClientFolder,
  deleteDropboxItemByPath,
} = require('./services/dropboxService');

const TEAM_FOLDER_NAMESPACE_ID = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
const namespaceHeader = JSON.stringify({ '.tag': 'namespace_id', namespace_id: TEAM_FOLDER_NAMESPACE_ID });

const getMetadata = async (accessToken, path) => {
  const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
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

  console.log('=== STEP 1: Settings.dropboxRootPath -> empty string ===');
  const before = await Settings.findOne();
  console.log(`Current dropboxRootPath: "${before.dropboxRootPath}"`);
  before.dropboxRootPath = '';
  await before.save();
  const after = await Settings.findOne();
  console.log(`New dropboxRootPath: "${after.dropboxRootPath}" (saved)`);

  console.log('\n=== STEP 2: Migrate the 1 misplaced file out of "/WOTC/Imran" into "/Imran" ===');
  const misplacedPath = '/WOTC/Imran/2026-08-29_153013_Screenshot 2026-07-24 103155.png';
  const misplacedCheck = await getMetadata(accessToken, misplacedPath);
  console.log(`Confirm file still at misplaced path: status ${misplacedCheck.status}`);
  if (misplacedCheck.status !== 200) {
    throw new Error(`SAFETY ABORT: expected the misplaced file at "${misplacedPath}", got status ${misplacedCheck.status}. Nothing further changed.`);
  }

  const newPath = await moveDropboxItemToClientFolder(
    misplacedPath,
    'Imran',
    '2026-08-29_153013_Screenshot 2026-07-24 103155.png'
  );
  console.log(`Moved to: ${newPath}`);

  const confirmNewLocation = await getMetadata(accessToken, newPath);
  console.log(`Confirm file now at "${newPath}": status ${confirmNewLocation.status}`);

  console.log('\n=== Cleanup: remove the now-empty leftover "/WOTC" subfolder inside the team folder ===');
  const wotcSubfolderCheck = await getMetadata(accessToken, '/WOTC');
  if (wotcSubfolderCheck.status === 200) {
    const listResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Dropbox-API-Path-Root': namespaceHeader },
      body: JSON.stringify({ path: '/WOTC' }),
    });
    const listData = await listResponse.json();
    console.log(`"/WOTC" subfolder entries remaining: ${listData.entries?.length}`);
    if (listData.entries?.length === 0) {
      await deleteDropboxItemByPath('/WOTC');
      console.log('Deleted the now-empty "/WOTC" subfolder.');
    } else {
      console.log('Not empty - leaving it alone, not deleting.');
    }
  } else {
    console.log(`"/WOTC" subfolder not found (status ${wotcSubfolderCheck.status}) - nothing to clean up.`);
  }

  console.log('\n=== STEP 3: Test - new dummy upload via real uploadFileToDropbox(), confirm no "WOTC" nesting ===');
  const testUploadPath = await uploadFileToDropbox('Imran', '_double_nesting_fix_test.txt', Buffer.from('post-fix test - safe to ignore/delete'), new Date());
  console.log(`uploadFileToDropbox() returned: ${testUploadPath}`);
  const isDirectUnderImran = /^\/Imran\//i.test(testUploadPath);
  console.log(`Path is directly under "/Imran" (no "/WOTC/Imran" nesting): ${isDirectUnderImran}`);

  const confirmTestUpload = await getMetadata(accessToken, testUploadPath);
  console.log(`Confirm via get_metadata: status ${confirmTestUpload.status}`);

  await deleteDropboxItemByPath(testUploadPath);
  console.log('Cleaned up the test file.');

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('\nSTOPPED:', err.message);
  mongoose.connection.close();
});
