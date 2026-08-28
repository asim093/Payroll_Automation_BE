require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const EmailLog = require('./models/EmailLog');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const run = async () => {
  try {
    await connectDB();

    const log = await EmailLog.findOne({ subject: /Elizabeth Beltran/ });
    console.log('=== Original stored EmailLog ===');
    console.log(`_id: ${log._id}`);
    console.log(`messageId: ${log.messageId}`);
    console.log(`receivedAt (stored): ${log.receivedAt.toISOString()}`);
    console.log(`createdAt (when OUR system logged it): ${log.createdAt.toISOString()}`);
    console.log(`attachments: ${JSON.stringify(log.attachments)}`);

    const accessToken = await getAccessTokenFromRefreshToken();
    const search = encodeURIComponent('"Elizabeth Beltran"');
    const url = `${GRAPH_BASE_URL}/me/messages?$search=${search}&$select=id,subject,receivedDateTime,sentDateTime,createdDateTime,hasAttachments,internetMessageId,conversationId&$top=5`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: 'eventual' },
    });
    const data = await response.json();

    console.log('\n=== Live search results (all matches) ===');
    (data.value || []).forEach((m, i) => {
      console.log(`\n--- Live result ${i + 1} ---`);
      console.log(`id: ${m.id}`);
      console.log(`internetMessageId: ${m.internetMessageId}`);
      console.log(`conversationId: ${m.conversationId}`);
      console.log(`receivedDateTime: ${m.receivedDateTime}`);
      console.log(`sentDateTime: ${m.sentDateTime}`);
      console.log(`createdDateTime: ${m.createdDateTime}`);
      console.log(`hasAttachments: ${m.hasAttachments}`);
      console.log(`SAME messageId as stored EmailLog? ${m.id === log.messageId}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
