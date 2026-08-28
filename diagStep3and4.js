require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const UnmatchedShareFileItem = require('./models/UnmatchedShareFileItem');
const Client = require('./models/Client');
const { getSettings } = require('./services/settingsService');
const { getShareFileContext } = require('./services/sharefileService');

const run = async () => {
  await connectDB();

  const totalUnresolved = await UnmatchedShareFileItem.countDocuments({ status: 'unresolved' });
  const totalAll = await UnmatchedShareFileItem.countDocuments({});
  console.log(`UnmatchedShareFileItem total: ${totalAll}, unresolved: ${totalUnresolved}`);

  const sample = await UnmatchedShareFileItem.find({ status: 'unresolved' }).sort({ discoveredAt: 1 }).limit(10);
  console.log('\nOldest 10 unresolved items (by discoveredAt):');
  sample.forEach((item) => {
    console.log(`  "${item.name}" (${item.itemType}) | path: ${item.path} | discoveredAt: ${item.discoveredAt.toISOString()} | lastSeenAt: ${item.lastSeenAt.toISOString()}`);
  });

  const sampleRecent = await UnmatchedShareFileItem.find({ status: 'unresolved' }).sort({ discoveredAt: -1 }).limit(10);
  console.log('\nNewest 10 unresolved items (by discoveredAt):');
  sampleRecent.forEach((item) => {
    console.log(`  "${item.name}" (${item.itemType}) | path: ${item.path} | discoveredAt: ${item.discoveredAt.toISOString()} | lastSeenAt: ${item.lastSeenAt.toISOString()}`);
  });

  console.log('\n=== STEP 4: live ShareFile API check for client "Imran" ===');
  const client = await Client.findOne({ name: 'Imran' });
  console.log(`Client "Imran" shareFilePath: "${client.shareFilePath}", isAbsolute: ${client.shareFilePathIsAbsolute}`);

  const { shareFileRootPath } = await getSettings();
  console.log(`Settings shareFileRootPath: "${shareFileRootPath}"`);

  const fullPath = `${shareFileRootPath}/${client.shareFilePath}`;
  console.log(`Full path to query: "${fullPath}"`);

  const { apiBase, authHeaders, rootId } = await getShareFileContext();
  console.log(`Resolved rootId (allshared alias): ${rootId}`);

  const url = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(fullPath)}`;
  const response = await fetch(url, { headers: authHeaders });
  console.log(`ByPath query status: ${response.status}`);
  const body = await response.text();
  console.log(`Response body: ${body.slice(0, 800)}`);

  console.log('\n=== Also list top-level children of the resolved root (Clients folder) ===');
  const rootPathUrl = `${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`;
  const rootPathResponse = await fetch(rootPathUrl, { headers: authHeaders });
  if (rootPathResponse.ok) {
    const rootFolder = await rootPathResponse.json();
    console.log(`Resolved "${shareFileRootPath}" folder Id: ${rootFolder.Id}, Name: ${rootFolder.Name}`);
    const childrenUrl = `${apiBase}/Items(${rootFolder.Id})/Children`;
    const childrenResponse = await fetch(childrenUrl, { headers: authHeaders });
    const childrenData = await childrenResponse.json();
    console.log(`Total children under "${shareFileRootPath}": ${(childrenData.value || []).length}`);
    console.log('First 15 child names:');
    (childrenData.value || []).slice(0, 15).forEach((c) => console.log(`  "${c.Name}" (${c['odata.type'] || 'unknown type'})`));
  } else {
    console.log(`Could not resolve root path "${shareFileRootPath}": status ${rootPathResponse.status}`);
    console.log(await rootPathResponse.text());
  }

  await mongoose.connection.close();
};
run();
