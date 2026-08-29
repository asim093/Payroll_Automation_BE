require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const OAuthCredential = require('./models/OAuthCredential');

const run = async () => {
  await connectDB();
  const creds = await OAuthCredential.find({});
  console.log(`Total OAuthCredential documents: ${creds.length}`);
  creds.forEach((cred) => {
    console.log(`\nprovider: ${cred.provider}`);
    console.log(`  refreshToken (first 12 chars): ${String(cred.refreshToken || '').slice(0, 12)}...`);
    console.log(`  refreshToken length: ${(cred.refreshToken || '').length}`);
    console.log(`  createdAt: ${cred.createdAt}`);
    console.log(`  updatedAt: ${cred.updatedAt}`);
  });
  await mongoose.connection.close();
};
run();
