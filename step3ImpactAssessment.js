require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');
const EmailLog = require('./models/EmailLog');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const KEYWORD_PATTERN = /\b(attach|attached|attachment|enclosed|enclosure)\b/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithSimpleRetry = async (url, headers, attempt = 0) => {
  const response = await fetch(url, { headers });
  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(response.headers.get('retry-after')) || 3;
    await sleep(retryAfter * 1000);
    return fetchWithSimpleRetry(url, headers, attempt + 1);
  }
  return response;
};

const run = async () => {
  try {
    await connectDB();
    const accessToken = await getAccessTokenFromRefreshToken();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const searchHeaders = { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: 'eventual' };

    const emailEntries = await ReviewQueue.find({ type: 'email' }).lean();
    const emailIds = emailEntries.map((entry) => entry.referenceId);
    const emailLogs = await EmailLog.find({ _id: { $in: emailIds }, 'attachments.0': { $exists: false } }).lean();

    console.log(`Checking ${emailLogs.length} non-attachment EmailLog records for "attach/enclosed" keyword in subject or body...\n`);

    const highRisk = [];
    const notFoundAnywhere = [];
    let checked = 0;

    for (const log of emailLogs) {
      checked++;
      const subjectHasKeyword = KEYWORD_PATTERN.test(log.subject || '');

      let bodyPreview = null;
      let foundVia = null;

      const directUrl = `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(log.messageId)}?$select=bodyPreview,hasAttachments`;
      const directResponse = await fetchWithSimpleRetry(directUrl, headers);
      if (directResponse.ok) {
        const data = await directResponse.json();
        bodyPreview = data.bodyPreview;
        foundVia = 'direct-id';
      } else if (log.subject) {
        const escapedSubject = log.subject.replace(/"/g, '');
        const searchUrl = `${GRAPH_BASE_URL}/me/messages?$search="${encodeURIComponent(escapedSubject)}"&$select=bodyPreview,hasAttachments,receivedDateTime&$top=1`;
        const searchResponse = await fetchWithSimpleRetry(searchUrl, searchHeaders);
        if (searchResponse.ok) {
          const data = await searchResponse.json();
          if (data.value && data.value.length > 0) {
            bodyPreview = data.value[0].bodyPreview;
            foundVia = 'search-fallback';
          }
        }
      }

      const bodyHasKeyword = bodyPreview ? KEYWORD_PATTERN.test(bodyPreview) : false;

      if (subjectHasKeyword || bodyHasKeyword) {
        highRisk.push({
          reviewQueueId: emailEntries.find((e) => String(e.referenceId) === String(log._id))?._id,
          emailLogId: log._id,
          subject: log.subject,
          sender: log.sender,
          matchedIn: subjectHasKeyword ? 'subject' : 'body',
          bodyPreview: bodyPreview ? bodyPreview.slice(0, 150) : null,
          foundVia,
        });
      }

      if (!bodyPreview && !subjectHasKeyword) {
        notFoundAnywhere.push({ emailLogId: log._id, subject: log.subject });
      }

      if (checked % 15 === 0) {
        console.log(`  ...checked ${checked}/${emailLogs.length}`);
      }
    }

    console.log(`\n=== HIGH RISK: ${highRisk.length} entries with "attach/enclosed"-style wording ===`);
    highRisk.forEach((item, index) => {
      console.log(`\n${index + 1}. ReviewQueue: ${item.reviewQueueId} | EmailLog: ${item.emailLogId}`);
      console.log(`   Subject: "${item.subject}"`);
      console.log(`   Sender: ${item.sender}`);
      console.log(`   Keyword matched in: ${item.matchedIn} (body fetched via: ${item.foundVia})`);
      if (item.bodyPreview) console.log(`   Body preview: "${item.bodyPreview}..."`);
    });

    console.log(`\n\nCould not fetch a body/subject-check at all for ${notFoundAnywhere.length} entries (likely moved/deleted from mailbox, unable to verify either way).`);
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
