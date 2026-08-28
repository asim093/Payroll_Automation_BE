require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const EmailLog = require('./models/EmailLog');

const run = async () => {
  await connectDB();

  const defaultFilterCount = await EmailLog.countDocuments({ archived: { $ne: true } });
  const allCount = await EmailLog.countDocuments({});
  const archivedCount = await EmailLog.countDocuments({ archived: true });

  console.log(`Default query (what Activity page will now see): ${defaultFilterCount}`);
  console.log(`Total in DB (unchanged, nothing deleted): ${allCount}`);
  console.log(`Archived (hidden from default, but still in DB): ${archivedCount}`);
  console.log(`Sanity check: ${defaultFilterCount} + ${archivedCount} = ${defaultFilterCount + archivedCount} (should equal ${allCount})`);

  console.log('\nSample of 3 archived records (still fully retrievable, proving they exist):');
  const sample = await EmailLog.find({ archived: true }).limit(3).select('subject sender status archived');
  sample.forEach((doc) => console.log(`  "${doc.subject}" | status: ${doc.status} | archived: ${doc.archived}`));

  await mongoose.connection.close();
};
run();
