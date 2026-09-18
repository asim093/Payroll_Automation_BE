require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');
const CustomerReportEmail = require('../../models/CustomerReportEmail');

const CLIENT_NAME = 'ZZZ Test Client 11';
const SERVICE_PATH = path.join(__dirname, '..', '..', 'services', 'customerEmailDraftService.js');
const TEMP_SERVICE_PATH = path.join(__dirname, '..', '..', 'services', '__customerEmailDraftService.livetest.js');

const run = async () => {
  await connectDB();

  // Same technique as testRealGraphDraftCreation.js: a temporary,
  // COMPLIANCE_EMAIL_SEND_ENABLED=true copy of customerEmailDraftService,
  // written next to the real one only so its relative requires resolve, then
  // deleted in the finally block. Never touches the real file on disk or the
  // running app's own process/module cache (this is a separate `node` run).
  const originalSource = fs.readFileSync(SERVICE_PATH, 'utf8');
  const patchedSource = originalSource.replace(
    'const COMPLIANCE_EMAIL_SEND_ENABLED = false;',
    'const COMPLIANCE_EMAIL_SEND_ENABLED = true; // LIVE TEST ONLY — temp file, deleted when this script exits'
  );
  if (patchedSource === originalSource) {
    throw new Error('Could not find "const COMPLIANCE_EMAIL_SEND_ENABLED = false;" in customerEmailDraftService.js — refusing to run.');
  }
  fs.writeFileSync(TEMP_SERVICE_PATH, patchedSource);

  let graphDraftId = null;

  try {
    const client = await Client.findOne({ name: CLIENT_NAME });
    if (!client) throw new Error(`"${CLIENT_NAME}" not found — run zzz11_setup.js + zzz11_run.js first.`);

    const row = await CustomerReportEmail.findOne({ clientId: client._id }).lean();
    if (!row) throw new Error(`No CustomerReportEmail row found for "${CLIENT_NAME}" — run zzz11_run.js first.`);
    console.log('Using existing staged row:', row._id.toString(), '| reportFilePath:', row.reportFilePath);

    // eslint-disable-next-line import/no-dynamic-require, global-require
    const { createCustomerReportDraftEmail, buildCustomerReportEmailPayload, COMPLIANCE_EMAIL_SEND_ENABLED } = require(TEMP_SERVICE_PATH);
    console.log('Patched module COMPLIANCE_EMAIL_SEND_ENABLED:', COMPLIANCE_EMAIL_SEND_ENABLED, '(expect true — this test process only)');

    const payload = await buildCustomerReportEmailPayload({ client, row });
    console.log('\nPayload built. from =', payload.from || '(unset — will use mailbox default)');
    console.log('to =', payload.to);
    console.log('subject =', JSON.stringify(payload.subject));
    console.log('reportFilePath =', payload.reportFilePath);

    console.log('\n--- Calling REAL createCustomerReportDraftEmail() against the connected mailbox ---');
    const result = await createCustomerReportDraftEmail(payload);
    graphDraftId = result.graphMessageId;
    console.log('Created real Graph draft. id =', graphDraftId);

    // Verify by reading the created message back from Graph.
    // eslint-disable-next-line global-require
    const { getAccessTokenFromRefreshToken } = require('../../services/delegatedAuthService');
    const accessToken = await getAccessTokenFromRefreshToken();
    const getResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${graphDraftId}?$select=id,isDraft,subject,body,from,toRecipients,hasAttachments`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!getResponse.ok) throw new Error(`Verify GET failed: HTTP ${getResponse.status}`);
    const created = await getResponse.json();

    const attachmentsResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${graphDraftId}/attachments?$select=id,name,contentType,size`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const attachmentsData = attachmentsResponse.ok ? await attachmentsResponse.json() : { value: [] };

    console.log('\n--- Verification against the real Graph message ---');
    console.log('isDraft:', created.isDraft, '(expect true — created, never sent)');
    console.log('subject matches payload:', created.subject === payload.subject);
    console.log(
      'from matches payload (if configured):',
      payload.from ? created.from?.emailAddress?.address?.toLowerCase() === payload.from.toLowerCase() : '(no from override configured — used mailbox default)'
    );
    console.log('toRecipients[0] matches the given recipient:', created.toRecipients?.[0]?.emailAddress?.address?.toLowerCase() === payload.to.toLowerCase());
    console.log('body content matches:', (created.body?.content || '').trim() === payload.body.trim());
    console.log('hasAttachments:', created.hasAttachments, '(expect true)');
    console.log('attachment count:', (attachmentsData.value || []).length, '(expect 1)');
    (attachmentsData.value || []).forEach((a) => console.log('  - attachment:', a.name, a.contentType, `${a.size} bytes`));
  } finally {
    if (graphDraftId) {
      try {
        // eslint-disable-next-line global-require
        const { getAccessTokenFromRefreshToken } = require('../../services/delegatedAuthService');
        const accessToken = await getAccessTokenFromRefreshToken();
        const delResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${graphDraftId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        console.log(
          `\nDeleted Graph draft ${graphDraftId} -> HTTP ${delResponse.status}`,
          delResponse.status === 204 ? '(confirmed deleted)' : '(NOT confirmed — check the mailbox manually!)'
        );
      } catch (error) {
        console.error(`!! FAILED TO DELETE GRAPH DRAFT ${graphDraftId} -> MANUAL CLEANUP REQUIRED:`, error.message);
      }
    }
    if (fs.existsSync(TEMP_SERVICE_PATH)) {
      fs.unlinkSync(TEMP_SERVICE_PATH);
      console.log('Deleted temp patched module file.');
    }
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exitCode = 1;
});
