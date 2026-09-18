const mongoose = require('mongoose');
const CustomerReportEmail = require('../models/CustomerReportEmail');
const Client = require('../models/Client');
const { paginate, isPaginationRequested } = require('../utils/paginate');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A client's report email is inherently one-per-run (unlike reminders, which
// are one-per-employee and refreshed in place across runs): every
// compliance-report run produces its own new row scoped to that run's
// complianceReportLogId. "Superseded" here means "a newer run has since
// produced its own report for this client, so this older un-actioned row is
// now stale" — analogous to ApplicantReminder's superseded semantics, just
// keyed by client+run instead of employee.
const SUPERSEDABLE_STATUSES = ['pending', 'failed', 'skipped_no_email'];

const upsertCustomerReportEmailFromRun = async ({ client, complianceReportLog, reportFilePath }) => {
  const customerEmail = String(client.complianceReportEmailDistribution || '').trim();
  const status = customerEmail ? 'pending' : 'skipped_no_email';

  const supersede = await CustomerReportEmail.updateMany(
    {
      clientId: client._id,
      status: { $in: SUPERSEDABLE_STATUSES },
      complianceReportLogId: { $ne: complianceReportLog._id },
    },
    { $set: { status: 'superseded' } }
  );

  const row = await CustomerReportEmail.create({
    clientId: client._id,
    complianceReportLogId: complianceReportLog._id,
    generatedAt: complianceReportLog.generatedAt,
    emailSalutation: client.emailSalutation || '',
    customerEmail,
    reportFilePath,
    status,
  });

  return { row, superseded: supersede.modifiedCount || 0 };
};

const REPORT_EMAIL_SORT_FIELDS = {
  generatedAt: 'generatedAt',
  status: 'status',
  customerEmail: 'customerEmail',
};
const REPORT_EMAIL_DEFAULT_SORT = { generatedAt: -1 };

const toPopulatedShape = (row) => {
  const { client, ...rest } = row;
  return { ...rest, clientId: client ? { _id: client._id, name: client.name } : row.clientId };
};

const listCustomerReportEmails = async (query = {}) => {
  const filter = {};
  if (query.clientId && mongoose.isValidObjectId(query.clientId)) {
    filter.clientId = new mongoose.Types.ObjectId(query.clientId);
  }
  if (query.status && query.status !== 'all') filter.status = query.status;

  // Search box on the Customer Emails page: matches either the customer
  // email address directly, or the client's name (via a small pre-lookup,
  // since clientId here is just a reference — not the aggregation path).
  const searchTerm = String(query.search || '').trim();
  if (searchTerm) {
    const regex = new RegExp(escapeRegExp(searchTerm), 'i');
    const matchingClients = await Client.find({ name: regex }).select('_id').lean();
    filter.$or = [{ customerEmail: regex }, { clientId: { $in: matchingClients.map((c) => c._id) } }];
  }

  const projection =
    'clientId complianceReportLogId generatedAt emailSalutation customerEmail reportFilePath status emailMode actionedAt actionedBy graphMessageId dryRun errorMessage';

  // Sorting by the client's name means sorting by a field on the referenced
  // Client document, not on CustomerReportEmail itself — same aggregation
  // approach (ObjectId-cast the filter explicitly for the raw $match) as
  // complianceReportController/applicantReminderService's sortBy=client.
  if (query.sortBy === 'client') {
    const dir = query.sortDir === 'desc' ? -1 : 1;
    const pipeline = [
      { $match: filter },
      { $lookup: { from: 'clients', localField: 'clientId', foreignField: '_id', as: 'client' } },
      { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
      { $sort: { 'client.name': dir, generatedAt: -1 } },
      { $project: Object.fromEntries(projection.split(' ').map((f) => [f, 1]).concat([['client', 1]])) },
    ];

    if (!isPaginationRequested(query)) {
      const rows = await CustomerReportEmail.aggregate(pipeline);
      return rows.map(toPopulatedShape);
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [rows, totalResult] = await Promise.all([
      CustomerReportEmail.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
      CustomerReportEmail.aggregate([...pipeline, { $count: 'total' }]),
    ]);
    const total = totalResult[0]?.total || 0;
    return { items: rows.map(toPopulatedShape), total, page, limit };
  }

  const dbQuery = CustomerReportEmail.find(filter).select(projection).populate('clientId', 'name');
  return paginate(dbQuery, CustomerReportEmail, filter, query, {
    sortFields: REPORT_EMAIL_SORT_FIELDS,
    defaultSort: REPORT_EMAIL_DEFAULT_SORT,
  });
};

const ALREADY_ACTIONED_STATUSES = ['draft_created', 'sent'];

const loadActionableRow = async (id) => {
  const row = await CustomerReportEmail.findById(id);
  if (!row) return { row: null, result: { id, status: 'not_found' } };
  if (row.status === 'sent') return { row, result: { id, status: 'already_sent' } };
  if (row.status === 'draft_created') return { row, result: { id, status: 'already_draft_created' } };
  if (row.status === 'skipped_no_email') return { row, result: { id, status: 'skipped_no_email' } };
  if (row.status === 'superseded') return { row, result: { id, status: 'superseded' } };
  const client = await require('../models/Client').findById(row.clientId);
  if (!client) return { row, result: { id, status: 'client_not_found' } };
  return { row, client };
};

const buildPreviewOrPayload = async ({ row, client }) => {
  const { buildCustomerReportEmailPayload } = require('./customerEmailDraftService');
  return buildCustomerReportEmailPayload({ client, row });
};

const previewCustomerReportEmails = async (ids) => {
  const results = [];
  for (const id of ids || []) {
    const { row, client, result } = await loadActionableRow(id);
    if (result) {
      results.push(result);
      continue;
    }
    if (!row.reportFilePath) {
      results.push({ id, status: 'not_ready', missing: ['reportFilePath'] });
      continue;
    }
    results.push({ id, status: 'ready', payload: await buildPreviewOrPayload({ row, client }) });
  }
  return results;
};

const actionCustomerReportEmails = async (ids, operatorEmail, mode = 'draft') => {
  const { createCustomerReportEmail, COMPLIANCE_EMAIL_SEND_ENABLED } = require('./customerEmailDraftService');

  if (mode === 'send' && COMPLIANCE_EMAIL_SEND_ENABLED !== true) {
    const error = new Error(
      'Real sending is not yet enabled for Customer Report emails (COMPLIANCE_EMAIL_SEND_ENABLED is false). Choose Draft instead, or ask an administrator to enable real sending first.'
    );
    error.statusCode = 400;
    throw error;
  }

  const results = [];

  for (const id of ids || []) {
    const { row, client, result } = await loadActionableRow(id);
    if (result) {
      results.push(result);
      continue;
    }

    if (!row.reportFilePath) {
      results.push({ id, status: 'failed', error: 'No report file recorded for this row.' });
      continue;
    }

    const payload = await buildPreviewOrPayload({ row, client });

    try {
      const outcome = await createCustomerReportEmail(payload, mode);
      const isRealSend = outcome.mode === 'send';
      row.status = isRealSend ? 'sent' : 'draft_created';
      row.emailMode = isRealSend ? 'send' : 'draft';
      row.dryRun = outcome.dryRun === true;
      row.graphMessageId = outcome.graphMessageId || null;
      row.actionedAt = new Date();
      row.actionedBy = operatorEmail || '';
      row.errorMessage = undefined;
      await row.save();
      results.push({ id, status: row.status, dryRun: row.dryRun, payloadPreview: outcome.payloadPreview });
    } catch (error) {
      row.status = 'failed';
      if (error.graphMessageId) row.graphMessageId = error.graphMessageId;
      row.errorMessage = error.message;
      await row.save();
      results.push({ id, status: 'failed', error: error.message, graphMessageId: error.graphMessageId || null });
    }
  }

  return results;
};

module.exports = {
  upsertCustomerReportEmailFromRun,
  listCustomerReportEmails,
  previewCustomerReportEmails,
  actionCustomerReportEmails,
};
