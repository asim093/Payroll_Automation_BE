require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');
const { generateAdminReport, saveReportToFile } = require('./services/complianceReportGeneratorService');
const { createComplianceReportDraft } = require('./services/complianceEmailDraftService');

const TARGET_EMAIL = process.argv[2];

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  const outputFolder = path.join(os.tmpdir(), `compliance-draft-test-${Date.now()}`);
  let reportPath = null;

  try {
    if (!TARGET_EMAIL) {
      throw new Error('Usage: node testComplianceEmailDraft.js <your-test-email-address>');
    }

    await connectDB();

    console.log('=== Building a dummy Phase-5 report to attach ===');
    const monday = new Date(Date.UTC(2024, 0, 8));
    const calculatedRecords = [
      { startDate: monday, employeeName: 'Employee One', ssn: '111111111', email: 'one@example.com', status: 'New', isComplete: true, weekEndingDate: new Date(Date.UTC(2024, 0, 14)) },
      { startDate: monday, employeeName: 'Employee Two', ssn: '222222222', email: 'two@example.com', status: 'Incomplete', isComplete: false, weekEndingDate: new Date(Date.UTC(2024, 0, 14)) },
    ];
    const weeklyStats = [{ weekEndingDate: new Date(Date.UTC(2024, 0, 14)), total: 2, completed: 1, incomplete: 1, completedPercentage: 50 }];
    const workbook = generateAdminReport('Acme Corp', calculatedRecords, weeklyStats);
    reportPath = await saveReportToFile(workbook, outputFolder, 'Compliance Report Acme Corp (Test Draft)');
    console.log('Report saved to:', reportPath);

    console.log('\n=== TEST 1: createComplianceReportDraft() - real Graph API call ===');
    const draftResult = await createComplianceReportDraft(
      TARGET_EMAIL,
      reportPath,
      'Compliance Report - Acme Corp (TEST DRAFT - please ignore)',
      'Hi Marcel\n\nAttached is the compliance report for this period. This is an automated test draft and was not sent.'
    );
    console.log('Draft creation result:', JSON.stringify(draftResult, null, 2));

    check('A draft ID was returned', Boolean(draftResult.draftId));
    check('isDraft is true', draftResult.isDraft === true);

    console.log('\n=== TEST 2: explicitly verify the message is in Drafts, not Sent Items ===');
    const accessToken = await getAccessTokenFromRefreshToken();

    const draftsResponse = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders('drafts')/messages?$select=id,subject,isDraft`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const draftsData = await draftsResponse.json();
    const foundInDrafts = (draftsData.value || []).some((message) => message.id === draftResult.draftId);
    check('Draft message found in the Drafts folder', foundInDrafts);

    const sentResponse = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages?$select=id,subject`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sentData = await sentResponse.json();
    const foundInSent = (sentData.value || []).some((message) => message.id === draftResult.draftId);
    check('Draft message NOT found in Sent Items', !foundInSent);

    const messageResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${draftResult.draftId}?$select=id,subject,isDraft`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const messageData = await messageResponse.json();
    console.log('Fetched message directly by ID:', JSON.stringify(messageData, null, 2));
    check('Message isDraft is still true when re-fetched directly', messageData.isDraft === true);

    console.log('\n=== TEST 3: confirm attachment is present ===');
    const attachmentsResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${draftResult.draftId}/attachments?$select=id,name,size`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const attachmentsData = await attachmentsResponse.json();
    console.log('Attachments on the draft:', JSON.stringify(attachmentsData.value, null, 2));
    check('Exactly 1 attachment present', (attachmentsData.value || []).length === 1);
    check('Attachment name matches the report file name', attachmentsData.value?.[0]?.name === path.basename(reportPath));
    check('Attachment has a non-zero size', (attachmentsData.value?.[0]?.size || 0) > 0);

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
    console.log(`\nOpen this draft yourself to visually confirm: https://outlook.office.com/mail/drafts`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    if (reportPath) {
      try {
        fs.unlinkSync(reportPath);
      } catch {}
    }
    try {
      fs.rmdirSync(outputFolder);
    } catch {}
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
