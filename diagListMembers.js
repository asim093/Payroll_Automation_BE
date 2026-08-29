require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getDropboxAccessToken } = require('./services/dropboxService');

const checkMembers = async (accessToken, sharedFolderId, label) => {
  console.log(`\n=== Members of "${label}" (shared_folder_id: ${sharedFolderId}) ===`);
  const response = await fetch('https://api.dropboxapi.com/2/sharing/list_folder_members', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_folder_id: sharedFolderId }),
  });
  console.log(`Status: ${response.status}`);
  const data = await response.json();
  if (!response.ok) {
    console.log(JSON.stringify(data));
    return;
  }
  (data.users || []).forEach((m) => {
    console.log(`  USER: ${m.user.email} | access: ${m.access_type['.tag']} | is_inherited: ${m.is_inherited}`);
  });
  (data.groups || []).forEach((g) => {
    console.log(`  GROUP: ${g.group.group_name} | access: ${g.access_type['.tag']}`);
  });
  (data.invitees || []).forEach((i) => {
    console.log(`  INVITEE (pending): ${i.invitee.email || JSON.stringify(i.invitee)}`);
  });
};

const run = async () => {
  await connectDB();
  const accessToken = await getDropboxAccessToken();

  await checkMembers(accessToken, '6325348304', 'WOTC (team folder, time_invited 2024-06-22)');
  await checkMembers(accessToken, '6252023632', "WOTC (DESKTOP-BSPVF7F's conflicted copy 2020-06-09)");

  await mongoose.connection.close();
};
run().catch((err) => {
  console.error('FATAL:', err.message);
  mongoose.connection.close();
});
