require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const MatchingRule = require('./models/MatchingRule');
const { matchClientBySender, matchClientBySubjectKeyword } = require('./services/clientMatcher');

const TEST_MARKER = '__testMatcher__';

const run = async () => {
  let clientOne, clientTwo;
  try {
    await connectDB();

    clientOne = await Client.create({ name: `${TEST_MARKER}_ClientOne`, status: 'active', matchingRules: {}, isDemoData: true });
    clientTwo = await Client.create({ name: `${TEST_MARKER}_ClientTwo`, status: 'active', matchingRules: {}, isDemoData: true });
    await MatchingRule.insertMany([
      { clientId: clientOne._id, type: 'exact_email', value: 'sender1@example.com', source: 'manual' },
      { clientId: clientTwo._id, type: 'domain', value: 'testcorp.com', source: 'manual' },
      { clientId: clientOne._id, type: 'subject_keyword', value: 'wotc batch', source: 'manual' },
    ]);
    const activeClients = [clientOne, clientTwo];

    const testCases = [
      { label: '(a) Exact email match', fn: () => matchClientBySender('sender1@example.com', '', activeClients), expected: clientOne.name },
      { label: '(b) Domain match, first-ever email from this address', fn: () => matchClientBySender('brand-new@testcorp.com', '', activeClients), expected: clientTwo.name },
      { label: '(c) No match', fn: () => matchClientBySender('random@nowhere.org', '', activeClients), expected: 'null' },
      { label: '(d) Subject-keyword match, via matchClientBySender', fn: () => matchClientBySender('random@nowhere.org', 'WOTC Batch ready for review', activeClients), expected: clientOne.name },
      { label: '(e) Subject-keyword match, standalone helper', fn: () => matchClientBySubjectKeyword('WOTC Batch ready for review', activeClients), expected: clientOne.name },
    ];

    for (const testCase of testCases) {
      const result = await testCase.fn();
      const resultLabel = result?.client ? `${result.client.name} (${result.method})` : result?.name || 'null';
      console.log(`\n${testCase.label}`);
      console.log(`  expected: ${testCase.expected}`);
      console.log(`  result:   ${resultLabel}`);
    }
  } catch (error) {
    console.error('Error running matcher tests:', error.message);
  } finally {
    const clientIds = [clientOne, clientTwo].filter(Boolean).map((c) => c._id);
    await MatchingRule.deleteMany({ clientId: { $in: clientIds } });
    await Client.deleteMany({ name: new RegExp(`^${TEST_MARKER}`) });
    await mongoose.connection.close();
    console.log('\nConnection closed. Test clients/rules cleaned up.');
  }
};

run();
