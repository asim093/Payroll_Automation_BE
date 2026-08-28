require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  await connectDB();
  const all = await ReviewQueue.find({ type: 'email' }).sort({ createdAt: 1 });
  const newArrivals = all.slice(109);
  console.log(`New arrivals (${newArrivals.length}):`);
  newArrivals.forEach((entry) => {
    console.log(`  ${entry._id} | resolvedClientId: ${entry.resolvedClientId} | archivedReason: ${entry.archivedReason} | reason: ${entry.reason} | createdAt: ${entry.createdAt}`);
  });
  const visible = await ReviewQueue.countDocuments({ type: 'email', resolvedClientId: null, archivedReason: null });
  console.log(`\nTotal visible now: ${visible}`);
  await mongoose.connection.close();
};
run();
