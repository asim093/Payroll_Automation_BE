require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const IgnoreRule = require('../models/IgnoreRule');

const run = async () => {
  await connectDB();

  const dropboxRules = await IgnoreRule.find({ scope: 'dropbox' }).lean();
  console.log(`IgnoreRule scope:dropbox — ${dropboxRules.length} found`);
  dropboxRules.forEach((r) => console.log(`  ${r.type} / ${r.action} / ${r.value}`));
  if (dropboxRules.length > 0) {
    const res = await IgnoreRule.deleteMany({ scope: 'dropbox' });
    console.log(`  deleted ${res.deletedCount}`);
  }

  const collections = await mongoose.connection.db.listCollections({ name: 'unmatcheddropboxitems' }).toArray();
  if (collections.length === 0) {
    console.log('unmatcheddropboxitems collection — already gone');
  } else {
    const count = await mongoose.connection.db.collection('unmatcheddropboxitems').countDocuments();
    console.log(`unmatcheddropboxitems collection — ${count} documents, dropping`);
    await mongoose.connection.db.collection('unmatcheddropboxitems').drop();
    console.log('  dropped');
  }

  await mongoose.disconnect();
  console.log('done');
  process.exit(0);
};

run().catch((error) => {
  console.error('removeDropboxIngestionData ERROR:', error.message);
  process.exit(1);
});
