require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { matchClientBySender } = require('./services/clientMatcher');

const testCases = [
  {
    label: '(a) Exact email match',
    senderEmail: 'sender1@example.com',
    expected: 'Test Client One',
  },
  {
    label: '(b) Domain-only match (different email, same domain)',
    senderEmail: 'someoneelse@testcorp.com',
    expected: 'Test Client Two',
  },
  {
    label: '(c) No match',
    senderEmail: 'random@nowhere.org',
    expected: 'null',
  },
];

const runTests = async () => {
  try {
    await connectDB();

    for (const testCase of testCases) {
      const result = await matchClientBySender(testCase.senderEmail);
      console.log(`\n${testCase.label}`);
      console.log(`  sender:   ${testCase.senderEmail}`);
      console.log(`  expected: ${testCase.expected}`);
      console.log(`  result:   ${result ? `${result.client.name} (${result.method})` : 'null'}`);
    }
  } catch (error) {
    console.error('Error running matcher tests:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

runTests();
