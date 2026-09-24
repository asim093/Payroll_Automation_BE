const crypto = require('crypto');
const mongoose = require('mongoose');
const Client = require('../models/Client');
const ApplicantReminder = require('../models/ApplicantReminder');
const { paginate, isPaginationRequested } = require('../utils/paginate');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const BULK_WRITE_CHUNK_SIZE = 150;

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
  let skippedNoSsn = 0;
  const validRecords = [];

  for (const record of incomplete) {
    const normalizedSsn = normalizeSsn(record.ssn);
    if (!normalizedSsn) {
      skippedNoSsn += 1;
      continue;
    }
    const employeeSsnHash = hashSsn(normalizedSsn);
    seenHashes.push(employeeSsnHash);
    validRecords.push({ record, normalizedSsn, employeeSsnHash });
  }

  let created = 0;
  let refreshed = 0;
  let held = 0;

  if (validRecords.length > 0) {
    const existingDocs = await ApplicantReminder.find(
      { clientId, employeeSsnHash: { $in: validRecords.map((v) => v.employeeSsnHash) } },
      { employeeSsnHash: 1, reminderStatus: 1 }
    ).lean();
    const existingStatusByHash = new Map(existingDocs.map((doc) => [doc.employeeSsnHash, doc.reminderStatus]));

    const buildOp = ({ record, normalizedSsn, employeeSsnHash }) => {
      const existingStatus = existingStatusByHash.get(employeeSsnHash);
      if (!existingStatus) created += 1;
      else if (ALREADY_ACTIONED_STATUSES.includes(existingStatus)) held += 1;
      else refreshed += 1;

      const isHeld = { $in: ['$reminderStatus', ALREADY_ACTIONED_STATUSES] };
      return {
        updateOne: {
          filter: { clientId, employeeSsnHash },
          update: [
            {
              $set: {
                clientId,
                employeeSsnHash,
                complianceRunAt,
                lastComplianceReportLogId: complianceReportLogId,
                logiformsStatusAtRun: record.status,
                incompleteKind: incompleteKindOf(record),
                employeeName: { $cond: [isHeld, '$employeeName', record.employeeName || ''] },
                employeeSsnLast4: { $cond: [isHeld, '$employeeSsnLast4', normalizedSsn.slice(-4)] },
                employeeEmail: { $cond: [isHeld, '$employeeEmail', record.email || ''] },
                hireDate: { $cond: [isHeld, '$hireDate', record.startDate || null] },
                weekEndingDate: { $cond: [isHeld, '$weekEndingDate', record.weekEndingDate || null] },
                reminderStatus: { $cond: [isHeld, '$reminderStatus', 'pending'] },
                reminderMode: { $ifNull: ['$reminderMode', 'draft'] },
                errorMessage: { $cond: [isHeld, '$errorMessage', '$$REMOVE'] },
              },
            },
          ],
          upsert: true,
        },
      };
    };

    for (let i = 0; i < validRecords.length; i += BULK_WRITE_CHUNK_SIZE) {
      const chunkOps = validRecords.slice(i, i + BULK_WRITE_CHUNK_SIZE).map(buildOp);
      await ApplicantReminder.bulkWrite(chunkOps, { ordered: false });
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

const listReminders = async ({ clientId, status, sortBy, sortDir, complianceReportLogId, search, page, limit } = {}) => {
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

  const searchTerm = String(search || '').trim();
  if (searchTerm) {
    const regex = new RegExp(escapeRegExp(searchTerm), 'i');
    query.$or = [{ employeeName: regex }, { employeeEmail: regex }];
  }

  const reqQuery = { sortBy, sortDir, page, limit };

  // Sorting by the client's name means sorting by a field on the referenced
  // Client document, not on ApplicantReminder itself — same aggregation
  // approach as matchingRuleController/complianceReportController's
  // sortBy=client (ObjectId-cast the filter explicitly: a raw $match does
  // NOT auto-cast a string against an ObjectId field the way .find() does).
  if (sortBy === 'client') {
    const dir = sortDir === 'desc' ? -1 : 1;
    const aggFilter = { ...query };
    if (aggFilter.clientId) aggFilter.clientId = new mongoose.Types.ObjectId(aggFilter.clientId);
    const pipeline = [
      { $match: aggFilter },
      { $lookup: { from: 'clients', localField: 'clientId', foreignField: '_id', as: 'client' } },
      { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
      { $sort: { 'client.name': dir, complianceRunAt: -1, createdAt: -1 } },
    ];

    if (!isPaginationRequested(reqQuery)) {
      const rows = await ApplicantReminder.aggregate(pipeline);
      return rows.map(toReminderPopulatedShape);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;
    const [rows, totalResult] = await Promise.all([
      ApplicantReminder.aggregate([...pipeline, { $skip: skip }, { $limit: limitNum }]),
      ApplicantReminder.aggregate([...pipeline, { $count: 'total' }]),
    ]);
    const total = totalResult[0]?.total || 0;
    return { items: rows.map(toReminderPopulatedShape), total, page: pageNum, limit: limitNum };
  }

  const dbQuery = ApplicantReminder.find(query).populate('clientId', 'name wotcFormUrl');
  return paginate(dbQuery, ApplicantReminder, query, reqQuery, {
    sortFields: REMINDER_SORT_FIELDS,
    defaultSort: REMINDER_DEFAULT_SORT,
  });
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

// Deletes drafted reminders: the real Graph draft (if one exists — a
// dry-run draft has no graphDraftId and nothing to delete there) AND the
// local row, for each id. Only rows actually in 'draft_created' are
// touched — the caller (controller) also enforces this, but this is
// checked again here since it's the one thing that must never be
// bypassed. Per-item: the DB row is removed even if the Graph delete
// fails, but that failure is reported back as a warning rather than
// silently succeeding.
const deleteReminderDrafts = async (ids) => {
  const { deleteGraphDraft } = require('./reminderDraftService');
  const results = [];

  for (const id of ids || []) {
    const row = await ApplicantReminder.findById(id);
    if (!row) {
      results.push({ id, success: false, error: 'Not found' });
      continue;
    }
    if (row.reminderStatus !== 'draft_created') {
      results.push({ id, success: false, error: `Not a draft (status: ${row.reminderStatus})` });
      continue;
    }

    let graphDeleted = null;
    let warning;
    if (row.graphDraftId) {
      try {
        await deleteGraphDraft(row.graphDraftId);
        graphDeleted = true;
      } catch (error) {
        graphDeleted = false;
        warning = `Graph draft could not be deleted (${error.message}) - the local record was still removed.`;
      }
    }

    await ApplicantReminder.deleteOne({ _id: id });
    results.push({ id, success: true, graphDeleted, warning });
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
  deleteReminderDrafts,
  normalizeSsn,
  hashSsn,
};
