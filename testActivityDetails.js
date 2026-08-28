require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const EmailLog = require('./models/EmailLog');
const FileLog = require('./models/FileLog');
const Client = require('./models/Client');
const { getActivityDetails } = require('./controllers/activityController');

const fakeRes = () => {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

const callEndpoint = async (id) => {
  const req = { params: { id } };
  const res = fakeRes();
  await getActivityDetails(req, res, (err) => {
    if (err) throw err;
  });
  return { statusCode: res.statusCode || 200, body: res.body };
};

const printResult = (label, result) => {
  console.log(`\n--- ${label} ---`);
  console.log(`status: ${result.statusCode}`);
  console.log(JSON.stringify(result.body, null, 2));
};

const runTests = async () => {
  try {
    await connectDB();

    console.log('=== TEST 1: existing EmailLog (status=processed, real data) ===');
    const processedEmail = await EmailLog.findOne({ status: 'processed' }).sort({ createdAt: -1 });
    if (processedEmail) {
      const result = await callEndpoint(`email-${processedEmail._id}`);
      printResult(`email-${processedEmail._id} (real, subject: "${processedEmail.subject}")`, result);
    } else {
      console.log('No processed EmailLog found in the database - skipping.');
    }

    console.log('\n=== TEST 2: existing EmailLog (status=needs_review, real data) ===');
    const needsReviewEmail = await EmailLog.findOne({ status: 'needs_review' }).sort({ createdAt: -1 });
    if (needsReviewEmail) {
      const result = await callEndpoint(`email-${needsReviewEmail._id}`);
      printResult(`email-${needsReviewEmail._id} (real, subject: "${needsReviewEmail.subject}")`, result);
    } else {
      console.log('No needs_review EmailLog found in the database - skipping.');
    }

    console.log('\n=== TEST 3: existing FileLog (status=moved, real data) ===');
    const movedFile = await FileLog.findOne({ status: 'moved' }).sort({ createdAt: -1 });
    if (movedFile) {
      const result = await callEndpoint(`file-${movedFile._id}`);
      printResult(`file-${movedFile._id} (real, file: "${movedFile.originalName}")`, result);
    } else {
      console.log('No moved FileLog found in the database - skipping.');
    }

    console.log('\n=== TEST 4: existing FileLog (status=failed, real data) ===');
    const failedFile = await FileLog.findOne({ status: 'failed' }).sort({ createdAt: -1 });
    if (failedFile) {
      const result = await callEndpoint(`file-${failedFile._id}`);
      printResult(`file-${failedFile._id} (real, file: "${failedFile.originalName}")`, result);
    } else {
      console.log('No failed FileLog found in the database - skipping.');
    }

    console.log('\n=== TEST 5: dummy scenario (manual match, inserted then deleted) ===');
    const anyClient = await Client.findOne();
    if (anyClient) {
      const dummyEmail = await EmailLog.create({
        messageId: `test-activity-details-${Date.now()}`,
        sender: 'dummy-sender@example-testing-only.invalid',
        subject: '[TEST] Dummy email for activity-details endpoint test',
        receivedAt: new Date(),
        matchedClientId: anyClient._id,
        status: 'processed',
        matchMethod: 'manual',
        attachments: [{ filename: 'dummy-payroll-file.xlsx', size: 12345 }],
        isDemoData: true,
      });
      try {
        const dummyFile = await FileLog.create({
          source: 'outlook',
          originalName: 'dummy-payroll-file.xlsx',
          sourceMessageId: dummyEmail.messageId,
          clientId: anyClient._id,
          destinationPath: `/WOTC/${anyClient.name}/dummy-payroll-file.xlsx`,
          destination: 'dropbox',
          status: 'moved',
          matchMethod: 'manual',
          processedAt: new Date(),
          isDemoData: true,
        });
        try {
          const result = await callEndpoint(`email-${dummyEmail._id}`);
          printResult(`email-${dummyEmail._id} (dummy, manual match)`, result);
        } finally {
          await FileLog.deleteOne({ _id: dummyFile._id });
          console.log(`\nCleaned up dummy FileLog ${dummyFile._id}`);
        }
      } finally {
        await EmailLog.deleteOne({ _id: dummyEmail._id });
        console.log(`Cleaned up dummy EmailLog ${dummyEmail._id}`);
      }
    } else {
      console.log('No client found in the database - skipping dummy-scenario test.');
    }

    console.log('\n=== TEST 6: invalid id format ===');
    try {
      const result = await callEndpoint('not-a-valid-id');
      printResult('not-a-valid-id', result);
    } catch (err) {
      console.log(`Threw as expected-ish: ${err.message}`);
    }

    console.log('\n=== TEST 7: well-formed id, non-existent record ===');
    const fakeObjectId = new mongoose.Types.ObjectId();
    const result7 = await callEndpoint(`email-${fakeObjectId}`);
    printResult(`email-${fakeObjectId} (does not exist)`, result7);
  } catch (error) {
    console.error('Error running activity-details tests:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

runTests();
