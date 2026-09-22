const crypto = require('crypto');
const mongoose = require('mongoose');
const Client = require('../models/Client');
const ApplicantReminder = require('../models/ApplicantReminder');

const RESETTABLE_STATUSES = ['pending', 'failed', 'skipped_no_email', 'skipped_no_form_url', 'superseded'];
const SUPERSEDABLE_STATUSES = ['pending', 'failed', 'skipped_no_email', 'skipped_no_form_url'];
// A reminder that was actually acted on — either drafted, really sent, or
// deliberately dismissed by an operator — is held as-is on future compliance
// runs and can never be silently re-actioned or reset. 'sent' must be
// included here for the same reason 'draft_created' already was: letting it
// fall through to RESETTABLE/SUPERSEDABLE would reopen an already-sent
// reminder, and once real sending goes live that means a duplicate real
// email. 'dismissed' is included for the same reason — a compliance run
// re-detecting the same still-incomplete employee should not silently
// un-dismiss an operator's explicit "don't send this" decision; only the
// Undismiss action should do that.
const ALREADY_ACTIONED_STATUSES = ['draft_created', 'sent', 'dismissed'];

const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

const hashSsn = (normalizedSsn) => crypto.createHash('sha256').update(normalizedSsn).digest('hex');

const incompleteKindOf = (record) =>
  record.status === 'Incomplete' ? 'no_logiforms_record' : 'unrecognized_status';

// complianceReportLogId (optional, 4th param): the Admin-type
// ComplianceReportLog._id for this specific run — stamped onto every row
// this call touches (create/refresh/hold) as lastComplianceReportLogId, an
// exact link for "which reminders belong to this run" rather than fuzzy
// complianceRunAt timestamp matching, which is unreliable once multiple
// clients' runs interleave under bounded concurrency. Optional so existing
// callers/tests that don't have a log id yet keep working unchanged.
const upsertFromComplianceRun = async (clientId, complianceRunAt, calculatedRecords, complianceReportLogId) => {
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
      lastComplianceReportLogId: complianceReportLogId,
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

    if (ALREADY_ACTIONED_STATUSES.includes(existing.reminderStatus)) {
      existing.complianceRunAt = complianceRunAt;
      existing.lastComplianceReportLogId = complianceReportLogId;
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

const REMINDER_SORT_FIELDS = {
  employeeName: 'employeeName',
  hireDate: 'hireDate',
  weekEndingDate: 'weekEndingDate',
  reminderStatus: 'reminderStatus',
};
const REMINDER_DEFAULT_SORT = { complianceRunAt: -1, createdAt: -1 };

const toReminderPopulatedShape = (row) => {
  const { client, ...rest } = row;
  return { ...rest, clientId: client ? { _id: client._id, name: client.name, wotcFormUrl: client.wotcFormUrl } : row.clientId };
};

const listReminders = ({ clientId, status, sortBy, sortDir, complianceReportLogId } = {}) => {
  const query = {};
  if (clientId) query.clientId = clientId;
  // 'all'/unset means "everything except dismissed" — a dismissed row is a
  // soft-delete out of the working view, only visible by explicitly asking
  // for status: 'dismissed' (the dedicated Dismissed tab).
  if (status && status !== 'all') query.reminderStatus = status;
  else query.reminderStatus = { $ne: 'dismissed' };
  // Scopes to one or more historical runs (the "View Emails" screen reached
  // from History — a single row's own link, or several checkbox-selected
  // rows at once) — the exact link added in Phase 1, not fuzzy timestamp
  // matching. Accepts either one id or a comma-separated list.
  const logIds = String(complianceReportLogId || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (logIds.length === 1) {
    query.lastComplianceReportLogId = logIds[0];
  } else if (logIds.length > 1) {
    query.lastComplianceReportLogId = { $in: logIds };
  }

  // Sorting by the client's name means sorting by a field on the referenced
  // Client document, not on ApplicantReminder itself — same aggregation
  // approach as matchingRuleController/complianceReportController's
  // sortBy=client (ObjectId-cast the filter explicitly: a raw $match does
  // NOT auto-cast a string against an ObjectId field the way .find() does).
  if (sortBy === 'client') {
    const dir = sortDir === 'desc' ? -1 : 1;
    const aggFilter = { ...query };
    if (aggFilter.clientId) aggFilter.clientId = new mongoose.Types.ObjectId(aggFilter.clientId);
    return ApplicantReminder.aggregate([
      { $match: aggFilter },
      { $lookup: { from: 'clients', localField: 'clientId', foreignField: '_id', as: 'client' } },
      { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
      { $sort: { 'client.name': dir, complianceRunAt: -1, createdAt: -1 } },
    ]).then((rows) => rows.map(toReminderPopulatedShape));
  }

  const sortField = sortBy && REMINDER_SORT_FIELDS[sortBy];
  const sort = sortField ? { [sortField]: sortDir === 'desc' ? -1 : 1 } : REMINDER_DEFAULT_SORT;

  return ApplicantReminder.find(query)
    .populate('clientId', 'name wotcFormUrl')
    .sort(sort)
    .lean();
};

const loadActionableRow = async (id) => {
  const row = await ApplicantReminder.findById(id);
  if (!row) return { row: null, result: { id, status: 'not_found' } };
  if (row.reminderStatus === 'sent') {
    return { row, result: { id, status: 'already_sent' } };
  }
  if (row.reminderStatus === 'dismissed') {
    return { row, result: { id, status: 'dismissed' } };
  }
  const client = await Client.findById(row.clientId);
  if (!client) return { row, result: { id, status: 'client_not_found' } };
  return { row, client };
};

const dismissReminders = async (ids, operatorEmail) => {
  const results = [];
  for (const id of ids || []) {
    const row = await ApplicantReminder.findById(id);
    if (!row) {
      results.push({ id, status: 'not_found' });
      continue;
    }
    if (row.reminderStatus === 'sent') {
      results.push({ id, status: 'already_sent' });
      continue;
    }
    row.reminderStatus = 'dismissed';
    row.reminderActionedAt = new Date();
    row.reminderActionedBy = operatorEmail || '';
    row.errorMessage = undefined;
    await row.save();
    results.push({ id, status: 'dismissed' });
  }
  return results;
};

const undismissReminders = async (ids) => {
  const results = [];
  for (const id of ids || []) {
    const row = await ApplicantReminder.findById(id);
    if (!row) {
      results.push({ id, status: 'not_found' });
      continue;
    }
    if (row.reminderStatus !== 'dismissed') {
      results.push({ id, status: 'not_dismissed' });
      continue;
    }
    row.reminderStatus = 'pending';
    row.reminderActionedAt = undefined;
    row.reminderActionedBy = '';
    await row.save();
    results.push({ id, status: 'pending' });
  }
  return results;
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


// onResult (optional): fired synchronously after each id finishes, so a
// caller running this in the background (see applicantReminderJobService)
// can report live per-item progress without waiting for the whole batch.
const actionReminders = async (ids, operatorEmail, mode = 'draft', onResult) => {
  const { buildReminderPayload, createReminderDraft, REMINDER_SEND_ENABLED } = require('./reminderDraftService');

  if (mode === 'send' && REMINDER_SEND_ENABLED !== true) {
    const error = new Error(
      'Real sending is not yet enabled for WOTC reminders (REMINDER_SEND_ENABLED is false). Choose Draft instead, or ask an administrator to enable real sending first.'
    );
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  const record = (result) => {
    results.push(result);
    if (onResult) onResult(result);
  };

  for (const id of ids || []) {
    const { row, client, result } = await loadActionableRow(id);
    if (result) {
      record(result);
      continue;
    }

    if (!row.employeeEmail) {
      row.reminderStatus = 'skipped_no_email';
      await row.save();
      record({ id, status: 'skipped_no_email' });
      continue;
    }
    if (!client.wotcFormUrl || !String(client.wotcFormUrl).trim()) {
      row.reminderStatus = 'skipped_no_form_url';
      await row.save();
      record({ id, status: 'skipped_no_form_url' });
      continue;
    }

    const payload = await buildReminderPayload({ client, toEmail: row.employeeEmail });

    try {
      const outcome = await createReminderDraft(payload, mode);
      // outcome.mode distinguishes a dry-run/real draft from a real send —
      // 'sent' must never be recorded as 'draft_created', both because it's
      // factually wrong and because loadActionableRow relies on the stored
      // status to block re-actioning an already-sent reminder.
      const isRealSend = outcome.mode === 'send';
      row.reminderStatus = isRealSend ? 'sent' : 'draft_created';
      row.reminderMode = isRealSend ? 'send' : 'draft';
      row.dryRun = outcome.dryRun === true;
      row.graphDraftId = outcome.graphDraftId || null;
      row.reminderActionedAt = new Date();
      row.reminderActionedBy = operatorEmail || '';
      row.errorMessage = undefined;
      await row.save();
      record({ id, status: row.reminderStatus, dryRun: row.dryRun, payloadPreview: outcome.payloadPreview });
    } catch (error) {
      row.reminderStatus = 'failed';
      // sendReminderEmail's orphaned-draft case (message created in Graph but
      // the /send call failed) still carries a real message id — keep it on
      // the record instead of losing that audit trail in the error text alone.
      if (error.graphMessageId) {
        row.graphDraftId = error.graphMessageId;
      }
      row.errorMessage = error.message;
      await row.save();
      record({ id, status: 'failed', error: error.message, graphMessageId: error.graphMessageId || null });
    }
  }

  return results;
};

module.exports = {
  upsertFromComplianceRun,
  listReminders,
  previewReminders,
  actionReminders,
  dismissReminders,
  undismissReminders,
  normalizeSsn,
  hashSsn,
};
