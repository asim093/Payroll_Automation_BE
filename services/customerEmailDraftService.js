const path = require('path');

const DEFAULT_SUBJECT_TEMPLATE = 'Compliance Report - {{Client Name}}';
const DEFAULT_BODY_TEMPLATE = '{{Salutation}}\n\nPlease find attached the compliance report for this period.';

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Two independent gates, deliberately not one (mirrors reminderDraftService):
//   - COMPLIANCE_DRAFT_LIVE_ENABLED (env-configurable) switches 'draft' mode
//     between a console-only dry-run log and a real Graph draft
//     (createCustomerReportDraftEmail). Reading this from .env is
//     intentional — a Graph draft only needs Mail.ReadWrite (already
//     granted), so this is the one thing meant to be operator-flippable
//     without a code change.
//   - COMPLIANCE_EMAIL_SEND_ENABLED stays a hardcoded constant, never read
//     from env on purpose, so 'send' mode always throws our own explicit
//     "not enabled" error below regardless of the draft flag above. Actually
//     sending still additionally requires the Mail.Send Graph scope, a
//     separate, external blocker on top of this one.
const COMPLIANCE_DRAFT_LIVE_ENABLED = process.env.COMPLIANCE_DRAFT_LIVE_ENABLED === 'true';
const COMPLIANCE_EMAIL_SEND_ENABLED = false;

const isDryRun = () => COMPLIANCE_DRAFT_LIVE_ENABLED !== true;

const customerEmailFromAddress = async () => {
  const { getSettings } = require('./settingsService');
  try {
    const settings = await getSettings();
    const configured = settings && settings.complianceReportEmailFromAddress;
    if (configured && String(configured).trim()) return String(configured).trim();
  } catch {
    /* fall through to the mailbox default */
  }
  try {
    const { resolveMailboxEmail } = require('./delegatedAuthService');
    return (await resolveMailboxEmail()) || '';
  } catch {
    return '';
  }
};

// The report file lives in Dropbox by the time a CustomerReportEmail row is
// actioned — the orchestrator's local temp copy is deleted at the end of
// that same run (see complianceReportOrchestratorService's `finally` block),
// so building the attachment here means downloading fresh from Dropbox by
// the row's stored reportFilePath, never reading a local path.
const buildAttachmentFromDropbox = async (reportFilePath) => {
  const { downloadDropboxFileBuffer } = require('./dropboxService');
  const buffer = await downloadDropboxFileBuffer(reportFilePath);

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `buildAttachmentFromDropbox failed: attachment too large (${buffer.length} bytes, limit ${MAX_ATTACHMENT_BYTES} bytes) - ${reportFilePath}`
    );
  }

  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: path.basename(reportFilePath),
    contentType: XLSX_MIME_TYPE,
    contentBytes: buffer.toString('base64'),
  };
};

const buildCustomerReportEmailPayload = async ({ client, row }) => {
  const { getSettings } = require('./settingsService');
  const { applyMergeFields } = require('../utils/applyMergeFields');

  let template = {};
  try {
    const settings = await getSettings();
    template = (settings && settings.complianceReportEmailTemplate) || {};
  } catch {
    template = {};
  }

  const subjectTemplate = template.subject && String(template.subject).trim() ? template.subject : DEFAULT_SUBJECT_TEMPLATE;
  const bodyTemplate = template.body && String(template.body).trim() ? template.body : DEFAULT_BODY_TEMPLATE;

  const mergeValues = {
    'Client Name': (client && client.name) || '',
    'WOTC Form URL': (client && client.wotcFormUrl) || '',
    Salutation: (row && row.emailSalutation) || (client && client.emailSalutation) || '',
  };

  return {
    from: await customerEmailFromAddress(),
    to: (row && row.customerEmail) || '',
    subject: applyMergeFields(subjectTemplate, mergeValues),
    body: applyMergeFields(bodyTemplate, mergeValues),
    reportFilePath: row && row.reportFilePath,
  };
};

// Step 1 only (POST /me/messages, no /send) — leaves a real Graph draft in
// Drafts for a human to review/send manually, with the compliance report
// attached. Only reachable once COMPLIANCE_DRAFT_LIVE_ENABLED is true; while
// it's false, createCustomerReportEmail's dry-run branch covers 'draft' mode
// with a console-only log instead of touching Graph or Dropbox at all.
const createCustomerReportDraftEmail = async (payload) => {
  const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
  const { from, to, subject, body, reportFilePath } = payload || {};

  if (!to || !String(to).trim()) {
    throw new Error('createCustomerReportDraftEmail failed: recipient address is required.');
  }
  if (!reportFilePath) {
    throw new Error('createCustomerReportDraftEmail failed: reportFilePath is required.');
  }

  const attachment = await buildAttachmentFromDropbox(reportFilePath);
  const accessToken = await getAccessTokenFromRefreshToken();

  const messagePayload = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    attachments: [attachment],
    ...(from ? { from: { emailAddress: { address: from } } } : {}),
  };

  let createResponse;
  try {
    createResponse = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });
  } catch (error) {
    throw new Error(`createCustomerReportDraftEmail failed: network error creating message - ${error.message}`);
  }

  if (!createResponse.ok) {
    const errorBody = await createResponse.text().catch(() => '');
    throw new Error(`createCustomerReportDraftEmail failed: Graph API returned ${createResponse.status} creating message - ${errorBody}`);
  }

  const createdMessage = await createResponse.json();
  return { graphMessageId: createdMessage.id, payloadPreview: { from, to, subject, body } };
};

// Real send path — same two-step create-then-send pattern as
// reminderDraftService.sendReminderEmail (a real Graph message id comes back
// for the audit trail; /me/sendMail would not return one). The send step
// follows creation immediately and automatically, no review pause.
const sendCustomerReportEmail = async (payload) => {
  const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
  const { from, to, subject, body, reportFilePath } = payload || {};

  if (!to || !String(to).trim()) {
    throw new Error('sendCustomerReportEmail failed: recipient address is required.');
  }
  if (!reportFilePath) {
    throw new Error('sendCustomerReportEmail failed: reportFilePath is required.');
  }

  const attachment = await buildAttachmentFromDropbox(reportFilePath);
  const accessToken = await getAccessTokenFromRefreshToken();
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const messagePayload = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    attachments: [attachment],
    ...(from ? { from: { emailAddress: { address: from } } } : {}),
  };

  let createResponse;
  try {
    createResponse = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(messagePayload),
    });
  } catch (error) {
    throw new Error(`sendCustomerReportEmail failed: network error creating message - ${error.message}`);
  }

  if (!createResponse.ok) {
    const errorBody = await createResponse.text().catch(() => '');
    throw new Error(`sendCustomerReportEmail failed: Graph API returned ${createResponse.status} creating message - ${errorBody}`);
  }

  const createdMessage = await createResponse.json();
  const messageId = createdMessage.id;

  let sendResponse;
  try {
    sendResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/send`, {
      method: 'POST',
      headers: authHeaders,
    });
  } catch (error) {
    const sendError = new Error(
      `sendCustomerReportEmail failed: message created (id: ${messageId}) but the /send call hit a network error - ${error.message}. This message is now an orphaned draft in Graph and was NOT sent.`
    );
    sendError.graphMessageId = messageId;
    sendError.orphanedDraft = true;
    throw sendError;
  }

  if (!sendResponse.ok) {
    const errorBody = await sendResponse.text().catch(() => '');
    const sendError = new Error(
      `sendCustomerReportEmail failed: message created (id: ${messageId}) but Graph API returned ${sendResponse.status} on /send - ${errorBody}. This message is now an orphaned draft in Graph and was NOT sent.`
    );
    sendError.graphMessageId = messageId;
    sendError.orphanedDraft = true;
    throw sendError;
  }

  return { sent: true, graphMessageId: messageId, payloadPreview: { from, to, subject, body } };
};

// `mode` ('draft' | 'send') is the per-request choice from the Customer
// Emails page UI toggle. Each mode has its own independent safety gate (see
// the two constants above) — flipping one never affects the other:
//   - mode 'send': requires COMPLIANCE_EMAIL_SEND_ENABLED === true, or this
//     throws an explicit error rather than quietly falling back to draft.
//     COMPLIANCE_EMAIL_SEND_ENABLED is a hardcoded constant (not
//     env-configurable), so this check always fires today regardless of
//     COMPLIANCE_DRAFT_LIVE_ENABLED.
//   - mode 'draft' (default): governed only by COMPLIANCE_DRAFT_LIVE_ENABLED —
//     today's dry-run log while it's false/unset, or a real Graph draft
//     (with the report attached) once it's set to 'true' in .env.
const createCustomerReportEmail = async (payload, mode = 'draft') => {
  const { from, to, subject, body } = payload || {};
  if (!to || !String(to).trim()) {
    throw new Error('createCustomerReportEmail failed: recipient address is required.');
  }

  if (mode === 'send') {
    if (COMPLIANCE_EMAIL_SEND_ENABLED !== true) {
      const error = new Error(
        'Real sending is not yet enabled for Customer Report emails (COMPLIANCE_EMAIL_SEND_ENABLED is false). Choose Draft instead, or ask an administrator to enable real sending first.'
      );
      error.statusCode = 400;
      throw error;
    }
    const result = await sendCustomerReportEmail(payload);
    return { dryRun: false, mode: 'send', graphMessageId: result.graphMessageId, payloadPreview: result.payloadPreview };
  }

  if (isDryRun()) {
    console.log(
      `[CUSTOMER-REPORT-EMAIL][DRY-RUN] would create a draft — from=${from || '(unset)'} to=${to} subject=${JSON.stringify(subject)}`
    );
    console.log(`[CUSTOMER-REPORT-EMAIL][DRY-RUN] body:\n${body}`);
    return { dryRun: true, mode: 'draft', graphMessageId: null, payloadPreview: { from, to, subject, body } };
  }

  const result = await createCustomerReportDraftEmail(payload);
  return { dryRun: false, mode: 'draft', graphMessageId: result.graphMessageId, payloadPreview: result.payloadPreview };
};

module.exports = {
  createCustomerReportEmail,
  createCustomerReportDraftEmail,
  sendCustomerReportEmail,
  buildCustomerReportEmailPayload,
  customerEmailFromAddress,
  isDryRun,
  COMPLIANCE_DRAFT_LIVE_ENABLED,
  COMPLIANCE_EMAIL_SEND_ENABLED,
  DEFAULT_SUBJECT_TEMPLATE,
  DEFAULT_BODY_TEMPLATE,
};
