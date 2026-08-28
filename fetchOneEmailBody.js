require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const stripHtml = (html) =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

const run = async () => {
  try {
    await connectDB();

    const accessToken = await getAccessTokenFromRefreshToken();

    const search = encodeURIComponent('"American Guard Services WOTC EE Name"');
    const url = `${GRAPH_BASE_URL}/me/messages?$search=${search}&$select=subject,from,receivedDateTime,bodyPreview,body,parentFolderId&$top=3`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: 'eventual' },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Graph API error ${response.status}: ${errorBody}`);
      return;
    }

    const data = await response.json();
    console.log(`Found ${data.value.length} live message(s) matching search.\n`);

    data.value.forEach((message, index) => {
      console.log(`=== Message ${index + 1} ===`);
      console.log(`Subject: "${message.subject}"`);
      console.log(`From: ${message.from?.emailAddress?.address}`);
      console.log(`Received: ${message.receivedDateTime}`);
      console.log(`\nbodyPreview: ${message.bodyPreview}`);
      console.log(`\nFull body (contentType: ${message.body?.contentType}):`);
      if (message.body?.contentType === 'html') {
        console.log(stripHtml(message.body.content));
      } else {
        console.log(message.body?.content);
      }
      console.log('\n---\n');
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
  }
};

run();
