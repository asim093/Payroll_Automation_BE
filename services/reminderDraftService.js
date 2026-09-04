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

const REMINDER_SEND_ENABLED = false;

const isDryRun = () => {
  if (REMINDER_SEND_ENABLED !== true) return true;
  if (process.env.REMINDER_DRAFTS_DRY_RUN !== 'false') return true;
  return false;
};

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

const createReminderDraft = async (payload) => {
  const { from, to, subject, body } = payload || {};
  if (!to || !String(to).trim()) {
    throw new Error('createReminderDraft failed: recipient address is required.');
  }

  if (isDryRun()) {
    console.log(
      `[WOTC-REMINDER][DRY-RUN] would create a draft — from=${from || '(unset)'} to=${to} subject=${JSON.stringify(subject)}`
    );
    console.log(`[WOTC-REMINDER][DRY-RUN] body:\n${body}`);
    return { dryRun: true, graphDraftId: null, payloadPreview: { from, to, subject, body } };
  }

  throw new Error(
    'createReminderDraft: real draft/send path is not implemented in this phase. ' +
      'This feature is draft-only and blocked on a sender-identity decision; do not enable it without explicit sign-off.'
  );
};

module.exports = {
  createReminderDraft,
  buildReminderPayload,
  reminderFromAddress,
  isDryRun,
  REMINDER_SEND_ENABLED,
  DEFAULT_SUBJECT,
  DEFAULT_BODY,
};
