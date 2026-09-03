const fs = require('fs');
const path = require('path');
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const buildAttachment = (reportFilePath) => {
  if (!fs.existsSync(reportFilePath)) {
    throw new Error(`createComplianceReportDraft failed: report file not found - ${reportFilePath}`);
  }

  const stats = fs.statSync(reportFilePath);
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `createComplianceReportDraft failed: attachment too large (${stats.size} bytes, limit ${MAX_ATTACHMENT_BYTES} bytes) - ${reportFilePath}`
    );
  }

  const fileBuffer = fs.readFileSync(reportFilePath);
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: path.basename(reportFilePath),
    contentType: XLSX_MIME_TYPE,
    contentBytes: fileBuffer.toString('base64'),
  };
};

const createComplianceReportDraft = async (clientEmail, reportFilePath, emailSubject, emailBody) => {
  if (!clientEmail) {
    throw new Error('createComplianceReportDraft failed: clientEmail is required.');
  }

  const attachment = buildAttachment(reportFilePath);
  const accessToken = await getAccessTokenFromRefreshToken();

  const messagePayload = {
    subject: emailSubject,
    body: { contentType: 'Text', content: emailBody },
    toRecipients: [{ emailAddress: { address: clientEmail } }],
    attachments: [attachment],
  };

  let response;
  try {
    response = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });
  } catch (error) {
    throw new Error(`createComplianceReportDraft failed: network error - ${error.message}`);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`createComplianceReportDraft failed: Graph API returned ${response.status} - ${errorBody}`);
  }

  const createdMessage = await response.json();

  if (createdMessage.isDraft !== true) {
    throw new Error('createComplianceReportDraft failed: Graph API did not return a draft message as expected.');
  }

  return {
    draftId: createdMessage.id,
    webLink: createdMessage.webLink,
    isDraft: createdMessage.isDraft,
  };
};

module.exports = { createComplianceReportDraft };
