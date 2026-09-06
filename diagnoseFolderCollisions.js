// Read-only diagnostic: lists every set of clients that resolve to the same
// canonical Dropbox or ShareFile folder. Two clients sharing a folder is the
// state that arms BUG-13 (deleting one with deleteFolders=true would destroy the
// other's files). Run before/after a bulk client import to confirm prod is clean.
//
//   node diagnoseFolderCollisions.js
//
// Touches nothing — only Client.find().lean(). Exit code 1 if any collision is
// found (so it can gate a rollout), 0 if clean.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const {
  dropboxFolderKey,
  shareFileFolderKey,
  loadFolderIdentitySettings,
} = require('./utils/clientFolderIdentity');

const groupByKey = (clients, keyFn) => {
  const groups = new Map();
  for (const client of clients) {
    const key = keyFn(client);
    if (!key || key === '/' || key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(client);
  }
  return [...groups.entries()].filter(([, members]) => members.length > 1);
};

const printCollisions = (label, collisions) => {
  if (collisions.length === 0) {
    console.log(`\n${label}: none — every client resolves to a distinct folder.`);
    return;
  }
  console.log(`\n${label}: ${collisions.length} shared folder(s) found`);
  for (const [key, members] of collisions) {
    console.log(`\n  ${key}`);
    for (const member of members) {
      const status = member.status ? ` [${member.status}]` : '';
      console.log(
        `    - "${member.name}"${status}  (id ${member._id})  dropboxPath=${JSON.stringify(member.dropboxPath || null)}` +
          ` abs=${Boolean(member.dropboxPathIsAbsolute)}  shareFilePath=${JSON.stringify(member.shareFilePath || null)}` +
          ` abs=${Boolean(member.shareFilePathIsAbsolute)}`
      );
    }
  }
};

const run = async () => {
  await connectDB();
  const settings = await loadFolderIdentitySettings();
  const clients = await Client.find()
    .select('name status dropboxPath dropboxPathIsAbsolute shareFilePath shareFilePathIsAbsolute')
    .lean();

  console.log(`Folder-collision diagnostic — ${clients.length} clients`);
  console.log(`Settings: dropboxRootPath=${JSON.stringify(settings.dropboxRootPath)} shareFileRootPath=${JSON.stringify(settings.shareFileRootPath)}` +
    ` teamNamespaceActive=${Boolean(process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID)}`);

  const dropboxCollisions = groupByKey(clients, (c) => dropboxFolderKey(c, settings.dropboxRootPath));
  const shareFileCollisions = groupByKey(clients, (c) => shareFileFolderKey(c, settings.shareFileRootPath));

  printCollisions('Dropbox', dropboxCollisions);
  printCollisions('ShareFile', shareFileCollisions);

  const total = dropboxCollisions.length + shareFileCollisions.length;
  console.log(
    `\nSUMMARY: ${total === 0 ? 'CLEAN — no shared folders.' : `${total} shared folder group(s) — review before relying on client delete.`}`
  );

  await mongoose.disconnect();
  process.exit(total === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error('diagnoseFolderCollisions ERROR:', error.message);
  process.exit(2);
});
