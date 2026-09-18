require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');
const ApplicantReminder = require('../../models/ApplicantReminder');

// The test recipient is read from the command line ONLY — never hardcode a
// real or fake address in this file. Use a clearly-fake, one-time-use
// address; this script creates a REAL Graph draft (Mail.ReadWrite, no send)
// in the actual connected mailbox and deletes it again before exiting.
const recipient = process.argv[2];
if (!recipient || !recipient.includes('@')) {
  console.error('Usage: node scripts/live-integration-checks/testRealGraphDraftCreation.js <fake-recipient-email>');
  console.error('This creates and then deletes a REAL Graph draft — never point it at a real applicant.');
  process.exit(1);
}

const CLIENT_NAME = 'ZZZ Test Client 10';
const SERVICE_PATH = path.join(__dirname, '..', '..', 'services', 'reminderDraftService.js');
const TEMP_SERVICE_PATH = path.join(__dirname, '..', '..', 'services', '__reminderDraftService.livetest.js');

const run = async () => {
  await connectDB();

  // A temporary, REMINDER_SEND_ENABLED=true copy of reminderDraftService,
  // written next to the real one only so its relative requires
  // (./settingsService, ./delegatedAuthService) resolve, then deleted in the
  // finally block below. This never modifies the real reminderDraftService.js
  // on disk, and — since this is a separate `node` process from the running
  // app — never affects the actual server's REMINDER_SEND_ENABLED, only this
  // script's own throwaway process.
  const originalSource = fs.readFileSync(SERVICE_PATH, 'utf8');
  const patchedSource = originalSource.replace(
    'const REMINDER_SEND_ENABLED = false;',
    'const REMINDER_SEND_ENABLED = true; // LIVE TEST ONLY — temp file, deleted when testRealGraphDraftCreation.js exits'
  );
  if (patchedSource === originalSource) {
    throw new Error('Could not find "const REMINDER_SEND_ENABLED = false;" in reminderDraftService.js — refusing to run (source may have changed).');
  }
  fs.writeFileSync(TEMP_SERVICE_PATH, patchedSource);

  let client = null;
  let reminder = null;
  let graphDraftId = null;

  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const { createGraphDraftEmail, buildReminderPayload, REMINDER_SEND_ENABLED } = require(TEMP_SERVICE_PATH);
    console.log('Patched module REMINDER_SEND_ENABLED:', REMINDER_SEND_ENABLED, '(expect true — this test process only)');

    client = await Client.create({
      name: CLIENT_NAME,
      status: 'inactive',
      wotcFormUrl: 'https://forms.example.com/wotc/zzz10',
    });
    console.log('Created test client:', client._id.toString());

    reminder = await ApplicantReminder.create({
      clientId: client._id,
      employeeSsnHash: 'zzz10-hash-1',
      employeeName: 'ZZZ Live Draft Test',
      employeeSsnLast4: '3333',
      employeeEmail: recipient,
      hireDate: new Date('2026-08-01'),
      weekEndingDate: new Date('2026-08-08'),
      logiformsStatusAtRun: 'Incomplete',
      reminderStatus: 'pending',
      complianceRunAt: new Date(),
    });
    console.log('Created test reminder row:', reminder._id.toString());

    const payload = await buildReminderPayload({ client, toEmail: recipient });
    console.log('\nPayload built. from =', payload.from || '(unset — will use mailbox default)');
    console.log('subject =', JSON.stringify(payload.subject));

    console.log('\n--- Calling REAL createGraphDraftEmail() against the connected mailbox ---');
    const result = await createGraphDraftEmail(payload);
    graphDraftId = result.graphDraftId;
    console.log('Created real Graph draft. id =', graphDraftId);

    // Verify by reading the created message back from Graph.
    // eslint-disable-next-line global-require
    const { getAccessTokenFromRefreshToken } = require('../../services/delegatedAuthService');
    const accessToken = await getAccessTokenFromRefreshToken();
    const getResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${graphDraftId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!getResponse.ok) throw new Error(`Verify GET failed: HTTP ${getResponse.status}`);
    const created = await getResponse.json();

    console.log('\n--- Verification against the real Graph message ---');
    console.log('isDraft:', created.isDraft, '(expect true — created, never sent)');
    console.log('subject matches payload:', created.subject === payload.subject);
    console.log(
      'from matches payload (if configured):',
      payload.from ? created.from?.emailAddress?.address?.toLowerCase() === payload.from.toLowerCase() : '(no from override configured — used mailbox default)'
    );
    console.log('toRecipients[0] matches the given recipient:', created.toRecipients?.[0]?.emailAddress?.address?.toLowerCase() === recipient.toLowerCase());
    console.log('body content matches:', (created.body?.content || '').trim() === payload.body.trim());
  } finally {
    // Cleanup order: the real Graph draft first (most important — never leave
    // a real mailbox item behind), then the temp module file, then the DB rows.
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
    if (reminder) {
      await ApplicantReminder.deleteOne({ _id: reminder._id });
      console.log('Deleted test ApplicantReminder row.');
    }
    if (client) {
      await Client.deleteOne({ _id: client._id });
      console.log('Deleted test Client.');
    }
    await mongoose.connection.close();
  }
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exitCode = 1;
});
