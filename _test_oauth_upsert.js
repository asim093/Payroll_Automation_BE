require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const OAuthCredential = require('./models/OAuthCredential');

const TEST_PROVIDER = '__test_upsert_provider__';

const saveLikeTheRealServicesDo = async (refreshToken, loggedInAs) => {
  await OAuthCredential.findOneAndUpdate(
    { provider: TEST_PROVIDER },
    { refreshToken, loggedInAs },
    { upsert: true }
  );
};

(async () => {
  await connectDB();
  try {
    await OAuthCredential.deleteMany({ provider: TEST_PROVIDER });

    console.log('=== Simulated login #1 ===');
    await saveLikeTheRealServicesDo('fake-refresh-token-AAA', 'user1@example.com');
    let docs = await OAuthCredential.find({ provider: TEST_PROVIDER }).lean();
    console.log('Documents for this provider:', docs.length, docs.length === 1 ? '✅' : '❌ FAIL');
    console.log('  refreshToken:', docs[0]?.refreshToken, '| loggedInAs:', docs[0]?.loggedInAs);
    console.log('  _id:', docs[0]?._id.toString());

    console.log('\n=== Simulated login #2 (re-login, different token) ===');
    await saveLikeTheRealServicesDo('fake-refresh-token-BBB', 'user1@example.com');
    docs = await OAuthCredential.find({ provider: TEST_PROVIDER }).lean();
    console.log('Documents for this provider:', docs.length, docs.length === 1 ? '✅ still just one document' : '❌ FAIL - duplicate created');
    console.log('  refreshToken:', docs[0]?.refreshToken, docs[0]?.refreshToken === 'fake-refresh-token-BBB' ? '✅ updated to new token' : '❌ FAIL - old token');
    console.log('  _id:', docs[0]?._id.toString(), '(same _id as login #1 confirms UPDATE not INSERT)');

    console.log('\n=== Simulated login #3 (third login, different account) ===');
    await saveLikeTheRealServicesDo('fake-refresh-token-CCC', 'user2@example.com');
    docs = await OAuthCredential.find({ provider: TEST_PROVIDER }).lean();
    console.log('Documents for this provider:', docs.length, docs.length === 1 ? '✅ still just one document' : '❌ FAIL - duplicate created');
    console.log('  refreshToken:', docs[0]?.refreshToken, '| loggedInAs:', docs[0]?.loggedInAs);

    await OAuthCredential.deleteMany({ provider: TEST_PROVIDER });
    console.log('\nCleaned up test provider documents. Real provider records (microsoft-delegated/dropbox/sharefile) untouched throughout.');
  } finally {
    await mongoose.connection.close();
  }
})();
