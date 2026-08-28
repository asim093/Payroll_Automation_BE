require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const run = async () => {
  try {
    await connectDB();
    const accessToken = await getAccessTokenFromRefreshToken();

    const search = encodeURIComponent('"American Guard Services WOTC EE Name- Elizabeth Beltran"');
    const url = `${GRAPH_BASE_URL}/me/messages?$search=${search}&$select=id,subject,hasAttachments&$top=1`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: 'eventual' },
    });
    const data = await response.json();
    console.log(JSON.stringify(data.value, null, 2));

    if (data.value?.[0]) {
      const messageId = data.value[0].id;
      const attUrl = `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}/attachments`;
      const attResponse = await fetch(attUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const attData = await attResponse.json();
      console.log('\nAttachments collection:');
      console.log(JSON.stringify(attData, null, 2));
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await mongoose.connection.close();
  }
};
run();
