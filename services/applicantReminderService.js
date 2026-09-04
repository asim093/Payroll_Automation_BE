const crypto = require('crypto');
const Client = require('../models/Client');
const ApplicantReminder = require('../models/ApplicantReminder');

const RESETTABLE_STATUSES = ['pending', 'failed', 'skipped_no_email', 'skipped_no_form_url', 'superseded'];
const SUPERSEDABLE_STATUSES = ['pending', 'failed', 'skipped_no_email', 'skipped_no_form_url'];

const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

const hashSsn = (normalizedSsn) => crypto.createHash('sha256').update(normalizedSsn).digest('hex');

const incompleteKindOf = (record) =>
  record.status === 'Incomplete' ? 'no_logiforms_record' : 'unrecognized_status';

const upsertFromComplianceRun = async (clientId, complianceRunAt, calculatedRecords) => {
  const incomplete = (calculatedRecords || []).filter((record) => !record.isComplete);

  const seenHashes = [];
  let created = 0;
  let refreshed = 0;
  let held = 0;
  let skippedNoSsn = 0;

  for (const record of incomplete) {
    const normalizedSsn = normalizeSsn(record.ssn);
    if (!normalizedSsn) {
      skippedNoSsn += 1;
      continue;
    }

    const employeeSsnHash = hashSsn(normalizedSsn);
    seenHashes.push(employeeSsnHash);

    const fields = {
      complianceRunAt,
      employeeName: record.employeeName || '',
      employeeSsnLast4: normalizedSsn.slice(-4),
      employeeEmail: record.email || '',
      hireDate: record.startDate || null,
      weekEndingDate: record.weekEndingDate || null,
      logiformsStatusAtRun: record.status,
      incompleteKind: incompleteKindOf(record),
    };

    const existing = await ApplicantReminder.findOne({ clientId, employeeSsnHash });

    if (!existing) {
      await ApplicantReminder.create({
        clientId,
        employeeSsnHash,
        reminderStatus: 'pending',
        reminderMode: 'draft',
        ...fields,
      });
      created += 1;
      continue;
    }

    if (existing.reminderStatus === 'draft_created') {
      existing.complianceRunAt = complianceRunAt;
      existing.logiformsStatusAtRun = record.status;
      existing.incompleteKind = incompleteKindOf(record);
      await existing.save();
      held += 1;
      continue;
    }

    if (RESETTABLE_STATUSES.includes(existing.reminderStatus)) {
      Object.assign(existing, fields, { reminderStatus: 'pending', errorMessage: undefined });
      await existing.save();
      refreshed += 1;
    }
  }

  const supersede = await ApplicantReminder.updateMany(
    {
      clientId,
      reminderStatus: { $in: SUPERSEDABLE_STATUSES },
      employeeSsnHash: { $nin: seenHashes },
    },
    { $set: { reminderStatus: 'superseded' } }
  );

  return {
    incompleteCount: incomplete.length,
    created,
    refreshed,
    held,
    superseded: supersede.modifiedCount || 0,
    skippedNoSsn,
  };
};

const listReminders = ({ clientId, status } = {}) => {
  const query = {};
  if (clientId) query.clientId = clientId;
  if (status && status !== 'all') query.reminderStatus = status;

  return ApplicantReminder.find(query)
    .populate('clientId', 'name wotcFormUrl')
    .sort({ complianceRunAt: -1, createdAt: -1 })
    .lean();
};

const loadActionableRow = async (id) => {
  const row = await ApplicantReminder.findById(id);
  if (!row) return { row: null, result: { id, status: 'not_found' } };
  if (row.reminderStatus === 'draft_created') {
    return { row, result: { id, status: 'already_draft_created' } };
  }
  const client = await Client.findById(row.clientId);
  if (!client) return { row, result: { id, status: 'client_not_found' } };
  return { row, client };
};

const previewReminders = async (ids) => {
  const { buildReminderPayload } = require('./reminderDraftService');
  const results = [];
  for (const id of ids || []) {
    const { row, client, result } = await loadActionableRow(id);
    if (result) {
      results.push(result);
      continue;
    }
    const missing = [];
    if (!row.employeeEmail) missing.push('employeeEmail');
    if (!client.wotcFormUrl || !String(client.wotcFormUrl).trim()) missing.push('wotcFormUrl');
    if (missing.length > 0) {
      results.push({ id, status: 'not_ready', missing });
      continue;
    }
    results.push({ id, status: 'ready', payload: await buildReminderPayload({ client, toEmail: row.employeeEmail }) });
  }
  return results;
};

const actionReminders = async (ids, operatorEmail) => {
  const { buildReminderPayload, createReminderDraft } = require('./reminderDraftService');
  const results = [];

  for (const id of ids || []) {
    const { row, client, result } = await loadActionableRow(id);
    if (result) {
      results.push(result);
      continue;
    }

    if (!row.employeeEmail) {
      row.reminderStatus = 'skipped_no_email';
      await row.save();
      results.push({ id, status: 'skipped_no_email' });
      continue;
    }
    if (!client.wotcFormUrl || !String(client.wotcFormUrl).trim()) {
      row.reminderStatus = 'skipped_no_form_url';
      await row.save();
      results.push({ id, status: 'skipped_no_form_url' });
      continue;
    }

    const payload = await buildReminderPayload({ client, toEmail: row.employeeEmail });

    try {
      const outcome = await createReminderDraft(payload);
      row.reminderStatus = 'draft_created';
      row.reminderMode = 'draft';
      row.dryRun = outcome.dryRun === true;
      row.graphDraftId = outcome.graphDraftId || null;
      row.reminderActionedAt = new Date();
      row.reminderActionedBy = operatorEmail || '';
      row.errorMessage = undefined;
      await row.save();
      results.push({ id, status: 'draft_created', dryRun: row.dryRun, payloadPreview: outcome.payloadPreview });
    } catch (error) {
      row.reminderStatus = 'failed';
      row.errorMessage = error.message;
      await row.save();
      results.push({ id, status: 'failed', error: error.message });
    }
  }

  return results;
};

module.exports = { upsertFromComplianceRun, listReminders, previewReminders, actionReminders, normalizeSsn, hashSsn };
