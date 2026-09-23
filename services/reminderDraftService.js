const DEFAULT_SUBJECT = 'Please complete your WOTC Questionnaire';
const DEFAULT_BODY = [
  'Dear Employee,',
  '',
  'Congratulations on your recent hire!',
  '',
  'Your employer, {{Customer}}, participates in the Work Opportunity Tax Credit (WOTC) Program.',
  '',
  'Our records indicate that your WOTC Questionnaire has not yet been completed.',
  '',
  'Please take a moment to complete the form by clicking the link below:',
  '',
  '{{WOTC Form URL}}',
  '',
  'Thank you for your prompt attention.',
].join('\n');

// Two independent gates, deliberately not one:
//   - REMINDER_DRAFT_LIVE_ENABLED (env-configurable) switches 'draft' mode
//     between a console-only dry-run log and a real Graph draft
//     (createGraphDraftEmail). Reading this from .env is intentional — it's
//     the one thing meant to be flippable by an operator without a code
//     change, since a Graph draft only needs Mail.ReadWrite (already
//     granted).
//   - REMINDER_SEND_ENABLED stays a hardcoded constant, never read from env
//     on purpose, so 'send' mode always throws our own explicit "not
//     enabled" error below regardless of the draft flag above — it does not
//     get any easier to reach a real send just by flipping an env var.
//     Actually sending still additionally requires the Mail.Send Graph
//     scope, which is a separate, external blocker on top of this one.
const REMINDER_DRAFT_LIVE_ENABLED = process.env.REMINDER_DRAFT_LIVE_ENABLED === 'true';
const REMINDER_SEND_ENABLED = false;

const isDryRun = () => REMINDER_DRAFT_LIVE_ENABLED !== true;

const reminderFromAddress = async () => {
  const { getSettings } = require('./settingsService');
  try {
    const settings = await getSettings();
    const configured = settings && settings.applicantReminderFromAddress;
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

const buildReminderPayload = async ({ client, toEmail }) => {
  const { getSettings } = require('./settingsService');
  const { applyApplicantMergeFields } = require('../utils/applyApplicantMergeFields');

  let template = {};
  try {
    const settings = await getSettings();
    template = (settings && settings.applicantReminderEmailTemplate) || {};
  } catch {
    template = {};
  }

  const subjectTemplate = template.subject && String(template.subject).trim() ? template.subject : DEFAULT_SUBJECT;
  const bodyTemplate = template.body && String(template.body).trim() ? template.body : DEFAULT_BODY;

  const values = {
    Customer: (client && client.name) || '',
    'WOTC Form URL': (client && client.wotcFormUrl) || '',
  };

  return {
    from: await reminderFromAddress(),
    to: toEmail,
    subject: applyApplicantMergeFields(subjectTemplate, values),
    body: applyApplicantMergeFields(bodyTemplate, values),
  };
};

// Real send path — immediate send, no manual review step, matching the
// original Excel tool's behavior exactly. Standalone: not wired into
// actionReminders yet (that's Phase 4). Same delegated-auth pattern as
// complianceEmailDraftService.createComplianceReportDraft.
//
// Two-step create-then-send (POST /me/messages, then POST
// /me/messages/{id}/send) rather than /me/sendMail, specifically so a real
// Graph message id comes back for the audit trail (graphDraftId) —
// /me/sendMail returns 202 with no body and no id. The send step follows
// creation immediately and automatically; nothing waits in Drafts for a
// human, so end-user behavior is still an unattended immediate send.
const sendReminderEmail = async (payload) => {
  const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
  const { fetchWithRetry } = require('./graphService');
  const { from, to, subject, body } = payload || {};

  if (!to || !String(to).trim()) {
    throw new Error('sendReminderEmail failed: recipient address is required.');
  }

  const accessToken = await getAccessTokenFromRefreshToken();
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const messagePayload = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    ...(from ? { from: { emailAddress: { address: from } } } : {}),
  };

  // Step 1: create the message.
  let createResponse;
  try {
    createResponse = await fetchWithRetry('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(messagePayload),
    });
  } catch (error) {
    throw new Error(`sendReminderEmail failed: network error creating message - ${error.message}`);
  }

  if (!createResponse.ok) {
    const errorBody = await createResponse.text().catch(() => '');
    throw new Error(`sendReminderEmail failed: Graph API returned ${createResponse.status} creating message - ${errorBody}`);
  }

  const createdMessage = await createResponse.json();
  const messageId = createdMessage.id;

  // Step 2: send that exact message, immediately and automatically — no
  // review step. If this fails, the message still exists as an orphaned
  // draft in Graph; surface that distinctly (with the id) rather than as a
  // generic failure, so the caller can tell "created but not sent" apart
  // from "never created at all".
  let sendResponse;
  try {
    sendResponse = await fetchWithRetry(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/send`, {
      method: 'POST',
      headers: authHeaders,
    });
  } catch (error) {
    const sendError = new Error(
      `sendReminderEmail failed: message created (id: ${messageId}) but the /send call hit a network error - ${error.message}. This message is now an orphaned draft in Graph and was NOT sent.`
    );
    sendError.graphMessageId = messageId;
    sendError.orphanedDraft = true;
    throw sendError;
  }

  if (!sendResponse.ok) {
    const errorBody = await sendResponse.text().catch(() => '');
    const sendError = new Error(
      `sendReminderEmail failed: message created (id: ${messageId}) but Graph API returned ${sendResponse.status} on /send - ${errorBody}. This message is now an orphaned draft in Graph and was NOT sent.`
    );
    sendError.graphMessageId = messageId;
    sendError.orphanedDraft = true;
    throw sendError;
  }

  return { sent: true, graphDraftId: messageId, payloadPreview: { from, to, subject, body } };
};

// Step 1 only (POST /me/messages, no /send) — leaves a real Graph draft in
// the Drafts folder for a human to review and send manually. This is the
// actual "Draft Email" behavior from the Excel (v9) source's emailOption,
// distinct from sendReminderEmail's create-then-send which never pauses for
// review. Only reachable once REMINDER_DRAFT_LIVE_ENABLED is true; while
// it's false, createReminderDraft's dry-run branch below covers "draft" mode
// with a console-only log instead of touching Graph at all.
const createGraphDraftEmail = async (payload) => {
  const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
  const { fetchWithRetry } = require('./graphService');
  const { from, to, subject, body } = payload || {};

  if (!to || !String(to).trim()) {
    throw new Error('createGraphDraftEmail failed: recipient address is required.');
  }

  const accessToken = await getAccessTokenFromRefreshToken();
  const messagePayload = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    ...(from ? { from: { emailAddress: { address: from } } } : {}),
  };

  let createResponse;
  try {
    createResponse = await fetchWithRetry('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });
  } catch (error) {
    throw new Error(`createGraphDraftEmail failed: network error creating message - ${error.message}`);
  }

  if (!createResponse.ok) {
    const errorBody = await createResponse.text().catch(() => '');
    throw new Error(`createGraphDraftEmail failed: Graph API returned ${createResponse.status} creating message - ${errorBody}`);
  }

  const createdMessage = await createResponse.json();
  return { graphDraftId: createdMessage.id, payloadPreview: { from, to, subject, body } };
};

// `mode` ('draft' | 'send') is the per-request choice from the Reminders page
// UI toggle. Each mode has its own independent safety gate (see the two
// constants above) — flipping one never affects the other:
//   - mode 'send': requires REMINDER_SEND_ENABLED === true, or this throws an
//     explicit error rather than quietly falling back to draft behavior.
//     REMINDER_SEND_ENABLED is a hardcoded constant (not env-configurable),
//     so this check always fires today regardless of REMINDER_DRAFT_LIVE_ENABLED.
//   - mode 'draft' (default): governed only by REMINDER_DRAFT_LIVE_ENABLED —
//     today's dry-run log while it's false/unset, or a real Graph draft once
//     it's set to 'true' in .env.
const createReminderDraft = async (payload, mode = 'draft') => {
  const { from, to, subject, body } = payload || {};
  if (!to || !String(to).trim()) {
    throw new Error('createReminderDraft failed: recipient address is required.');
  }

  if (mode === 'send') {
    if (REMINDER_SEND_ENABLED !== true) {
      const error = new Error(
        'Real sending is not yet enabled for WOTC reminders (REMINDER_SEND_ENABLED is false). Choose Draft instead, or ask an administrator to enable real sending first.'
      );
      error.statusCode = 400;
      throw error;
    }
    const result = await sendReminderEmail(payload);
    return { dryRun: false, mode: 'send', graphDraftId: result.graphDraftId, payloadPreview: result.payloadPreview };
  }

  if (isDryRun()) {
    console.log(
      `[WOTC-REMINDER][DRY-RUN] would create a draft — from=${from || '(unset)'} to=${to} subject=${JSON.stringify(subject)}`
    );
    console.log(`[WOTC-REMINDER][DRY-RUN] body:\n${body}`);
    return { dryRun: true, mode: 'draft', graphDraftId: null, payloadPreview: { from, to, subject, body } };
  }

  const result = await createGraphDraftEmail(payload);
  return { dryRun: false, mode: 'draft', graphDraftId: result.graphDraftId, payloadPreview: result.payloadPreview };
};

module.exports = {
  createReminderDraft,
  createGraphDraftEmail,
  sendReminderEmail,
  buildReminderPayload,
  reminderFromAddress,
  isDryRun,
  REMINDER_DRAFT_LIVE_ENABLED,
  REMINDER_SEND_ENABLED,
  DEFAULT_SUBJECT,
  DEFAULT_BODY,
};
