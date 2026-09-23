const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const CustomerReportEmail = require('../models/CustomerReportEmail');
const ApplicantReminder = require('../models/ApplicantReminder');
const { generateComplianceReportsForMultipleClients } = require('../services/complianceReportOrchestratorService');
const { downloadDropboxFileBuffer } = require('../services/dropboxService');
const { paginate, isPaginationRequested, DEFAULT_LIMIT, MAX_LIMIT } = require('../utils/paginate');
const { createJob, getJob, getActiveJob, recordResult, setJobWarnings, markJobFailed } = require('../services/complianceReportGenerationJobs');

// A run's period isn't stored as its own field — it's derived from the
// min/max weekEndingDate already present in weeklyBreakdown, so there's no
// second source of truth to keep in sync with it.
const derivePeriod = (weeklyBreakdown) => {
  const timestamps = (weeklyBreakdown || [])
    .map((week) => week.weekEndingDate)
    .filter(Boolean)
    .map((date) => new Date(date).getTime())
    .filter((time) => Number.isFinite(time));
  if (timestamps.length === 0) return null;
  return { start: new Date(Math.min(...timestamps)), end: new Date(Math.max(...timestamps)) };
};

// "sent" is a run's aggregate bucket, not a literal status value: a draft
// that's been created counts as sent for tracking purposes even though the
// row's own status stays 'draft_created' (that row-level distinction is
// still useful elsewhere — re-draftability, dry-run tracking — so it's kept,
// just folded into this one bucket for run-summary counts).
const SENT_BUCKET_STATUSES = ['draft_created', 'sent'];
const bucketRunCounts = (statusCounts) => ({
  sent: SENT_BUCKET_STATUSES.reduce((sum, status) => sum + (statusCounts[status] || 0), 0),
  dismissed: statusCounts.dismissed || 0,
  failed: statusCounts.failed || 0,
  pending: statusCounts.pending || 0,
});

// Computed on demand every call — deliberately never cached/stored on the
// run itself, so these counts can never drift stale relative to the actual
// CustomerReportEmail/ApplicantReminder rows they summarize.
const attachRunCounts = async (rows) => {
  const clientLogIds = rows.map((row) => row.clientLogId).filter(Boolean);
  const adminLogIds = rows.map((row) => row.adminLogId).filter(Boolean);

  const [emailStatusRows, reminderStatusRows] = await Promise.all([
    clientLogIds.length
      ? CustomerReportEmail.aggregate([
          { $match: { complianceReportLogId: { $in: clientLogIds } } },
          { $group: { _id: { logId: '$complianceReportLogId', status: '$status' }, count: { $sum: 1 } } },
        ])
      : [],
    adminLogIds.length
      ? ApplicantReminder.aggregate([
          { $match: { lastComplianceReportLogId: { $in: adminLogIds } } },
          { $group: { _id: { logId: '$lastComplianceReportLogId', status: '$reminderStatus' }, count: { $sum: 1 } } },
        ])
      : [],
  ]);

  const emailCountsByLogId = new Map();
  for (const entry of emailStatusRows) {
    const key = String(entry._id.logId);
    if (!emailCountsByLogId.has(key)) emailCountsByLogId.set(key, {});
    emailCountsByLogId.get(key)[entry._id.status] = entry.count;
  }
  const reminderCountsByLogId = new Map();
  for (const entry of reminderStatusRows) {
    const key = String(entry._id.logId);
    if (!reminderCountsByLogId.has(key)) reminderCountsByLogId.set(key, {});
    reminderCountsByLogId.get(key)[entry._id.status] = entry.count;
  }

  return rows.map((row) => {
    const { weeklyBreakdown, ...rest } = row;
    return {
      ...rest,
      period: derivePeriod(weeklyBreakdown),
      counts: {
        clientEmails: bucketRunCounts((row.clientLogId && emailCountsByLogId.get(String(row.clientLogId))) || {}),
        applicantReminders: bucketRunCounts((row.adminLogId && reminderCountsByLogId.get(String(row.adminLogId))) || {}),
      },
    };
  });
};

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Aggregation-only reshape (sortBy=client path): $lookup/$unwind produce a
// `client` subdocument, not the `clientId` populated the Mongoose way —
// normalize back to the same { clientId: { _id, name } } shape .populate()
// gives on the plain-query path, so the frontend reads one consistent shape
// regardless of which path served the request. Same pattern as
// matchingRuleController's toPopulatedShape.
const toClientShape = (row) => {
  const { client, ...rest } = row;
  return { ...rest, clientId: client ? { _id: client._id, name: client.name } : row.clientId };
};

// Still fire-and-forget (the actual generation work is unchanged and keeps
// running in the background after this responds), but now returns a jobId
// so the frontend can poll /generate-status/:jobId for a live progress
// indicator instead of guessing when it's done.
const generateReports = async (req, res) => {
  const { clientIds } = req.body || {};

  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return res.status(400).json({ error: 'clientIds must be a non-empty array' });
  }

  const jobId = await createJob(clientIds);
  res.json({ success: true, jobId });

  generateComplianceReportsForMultipleClients(clientIds, {
    onResult: (result) => recordResult(jobId, result),
    onLogiFormsWarnings: (skippedRows) => setJobWarnings(jobId, skippedRows),
  }).catch(async (error) => {
    console.error(`[COMPLIANCE-REPORTS] generateComplianceReportsForMultipleClients rejected unexpectedly: ${error.message}`);
    const job = await getJob(jobId);
    const alreadyReported = job ? job.completed : 0;
    const startedFromZero = alreadyReported === 0;
    for (let i = alreadyReported; i < clientIds.length; i += 1) {
      await recordResult(jobId, { success: false, clientId: clientIds[i], error: error.message });
    }
    if (startedFromZero) await markJobFailed(jobId);
  });
};

const getGenerateReportsStatus = async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have already expired).' });
  }
  res.json(job);
};

const getActiveGenerateStatus = async (req, res) => {
  const job = await getActiveJob();
  if (!job) {
    return res.json({ active: false });
  }
  res.json({ active: true, ...job });
};

// Lists every client (not just active) so a report can be reviewed/generated
// for a client before it's activated — the Generate flow itself warns about
// inactive/no-email clients rather than hiding them from this list.
const getComplianceReportStatus = async (req, res, next) => {
  try {
    const clients = await Client.find({})
      .select('name fein status complianceReportEmailDistribution')
      .sort({ name: 1 })
      .lean();

    const clientIds = clients.map((client) => client._id);
    const logs = await ComplianceReportLog.find({ clientId: { $in: clientIds } })
      .sort({ generatedAt: -1 })
      .lean();

    // One most-recent-successful log per (client, reportType) — the Admin and
    // Client versions are generated moments apart and tracked separately, so
    // "last report" isn't a single value per client. Used for canView/
    // click-through: there's an actual report to open.
    const lastByClientAndType = new Map();
    // Separately, the most recent log per (client, reportType) REGARDLESS of
    // success — used only to show the true current status (a client whose
    // latest run failed should show "Failed", not silently fall back to an
    // older success or "Not yet generated").
    const latestAttemptByClientAndType = new Map();
    for (const log of logs) {
      const key = `${log.clientId}:${log.reportType}`;
      if (!latestAttemptByClientAndType.has(key)) {
        latestAttemptByClientAndType.set(key, log);
      }
      if (!log.success) continue;
      if (!lastByClientAndType.has(key)) {
        lastByClientAndType.set(key, log);
      }
    }

    const result = clients.map((client) => ({
      ...client,
      lastReports: {
        Admin: lastByClientAndType.get(`${client._id}:Admin`) || null,
        Client: lastByClientAndType.get(`${client._id}:Client`) || null,
      },
      lastAttempts: {
        Admin: latestAttemptByClientAndType.get(`${client._id}:Admin`) || null,
        Client: latestAttemptByClientAndType.get(`${client._id}:Client`) || null,
      },
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// Streams the most recent SUCCESSFUL report file of the given type back to
// the browser as a download, fetched fresh from Dropbox via the existing
// download service (no local caching of report files).
const downloadComplianceReport = async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const typeParam = String(req.query.type || '').toLowerCase();
    const reportType = typeParam === 'admin' ? 'Admin' : typeParam === 'client' ? 'Client' : null;
    if (!reportType) {
      return res.status(400).json({ error: 'type query param must be "admin" or "client"' });
    }

    const log = await ComplianceReportLog.findOne({ clientId, reportType, success: true })
      .sort({ generatedAt: -1 })
      .lean();
    if (!log || !log.filePath) {
      return res.status(404).json({ error: 'No generated report found for this client/type yet.' });
    }

    const buffer = await downloadDropboxFileBuffer(log.filePath);
    const fileName = path.basename(log.filePath);

    res.setHeader('Content-Type', XLSX_MIME_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};

// Query params (all optional): clientId, reportType ('Admin'|'Client'),
// success ('true'|'false'), dateFrom/dateTo (filter on generatedAt),
// page/limit/sortBy/sortDir (reuses the same reusable paginate() utility
// built for the Rules page — with no page/limit, this returns a plain array
// the same way that endpoint does).
const getComplianceReportHistory = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.clientId && mongoose.isValidObjectId(req.query.clientId)) {
      // Cast explicitly: the plain .find() path below auto-casts via the
      // schema, but the sortBy=client aggregation path runs this same filter
      // through a raw $match, which does NOT auto-cast a string against an
      // ObjectId field and would otherwise match nothing.
      filter.clientId = new mongoose.Types.ObjectId(req.query.clientId);
    }
    if (req.query.reportType === 'Admin' || req.query.reportType === 'Client') {
      filter.reportType = req.query.reportType;
    }
    if (req.query.success === 'true') filter.success = true;
    else if (req.query.success === 'false') filter.success = false;
    // emailStatus (History page filter): 'failed' means the report itself
    // never generated (no emails exist at all); 'pending'/'success' both
    // imply the run generated fine, so they narrow to success:true here and
    // get split further below (in-memory, after counts are attached — an
    // applicant's email-completion state isn't a field on ComplianceReportLog
    // itself, so it can't be expressed as a $match on this collection alone).
    const emailStatusFilter = ['pending', 'success', 'failed'].includes(req.query.emailStatus)
      ? req.query.emailStatus
      : null;
    if (emailStatusFilter === 'failed') filter.success = false;
    else if (emailStatusFilter === 'pending' || emailStatusFilter === 'success') filter.success = true;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const projection =
      'generatedAt clientId reportType success totalEmployees completedCount incompleteCount duplicateSsnCount emailStatus errorMessage filePath weeklyBreakdown';

    // grouped=true: one row per compliance run instead of one per report
    // file. Admin and Client logs from the same run always share the exact
    // same generatedAt and the same totalEmployees/completedCount/
    // incompleteCount (computed once in the orchestrator and written to both
    // documents) — a failed run only ever writes a single Admin-type log
    // (see logFailure in complianceReportOrchestratorService.js), so grouping
    // by (clientId, generatedAt) is always safe. Only the History page opts
    // into this; other callers (ClientComplianceTab's mini history table,
    // ComplianceReportDetailPage's unpaginated per-client fetch) keep reading
    // raw per-file logs untouched.
    if (req.query.grouped === 'true') {
      const GROUPED_SORT_FIELDS = {
        generatedAt: 'generatedAt',
        client: 'client.name',
        success: 'success',
        totalEmployees: 'totalEmployees',
        completedCount: 'completedCount',
        incompleteCount: 'incompleteCount',
      };
      const sortField = GROUPED_SORT_FIELDS[req.query.sortBy] || 'generatedAt';
      const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

      const pipeline = [
        { $match: filter },
        {
          $group: {
            _id: { clientId: '$clientId', generatedAt: '$generatedAt' },
            success: { $max: '$success' },
            errorMessage: { $first: '$errorMessage' },
            totalEmployees: { $first: '$totalEmployees' },
            completedCount: { $first: '$completedCount' },
            incompleteCount: { $first: '$incompleteCount' },
            duplicateSsnCount: { $first: '$duplicateSsnCount' },
            sourcePayrollFileName: { $first: '$sourcePayrollFileName' },
            sourcePayrollFilePath: { $first: '$sourcePayrollFilePath' },
            weeklyBreakdown: { $first: '$weeklyBreakdown' },
            logs: { $push: { _id: '$_id', reportType: '$reportType' } },
          },
        },
        {
          $addFields: {
            clientId: '$_id.clientId',
            generatedAt: '$_id.generatedAt',
            adminLog: { $first: { $filter: { input: '$logs', cond: { $eq: ['$$this.reportType', 'Admin'] } } } },
            clientLog: { $first: { $filter: { input: '$logs', cond: { $eq: ['$$this.reportType', 'Client'] } } } },
          },
        },
        { $lookup: { from: 'clients', localField: 'clientId', foreignField: '_id', as: 'client' } },
        { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
        { $sort: { [sortField]: sortDir, generatedAt: -1 } },
        {
          $project: {
            _id: 0,
            generatedAt: 1,
            clientId: { _id: '$client._id', name: '$client.name' },
            success: 1,
            errorMessage: 1,
            totalEmployees: 1,
            completedCount: 1,
            incompleteCount: 1,
            duplicateSsnCount: 1,
            sourcePayrollFileName: 1,
            sourcePayrollFilePath: 1,
            weeklyBreakdown: 1,
            adminLogId: '$adminLog._id',
            clientLogId: '$clientLog._id',
          },
        },
      ];

      // pending/success can't be resolved by the DB query alone (see above),
      // so this branch fetches every success:true row matching the other
      // filters, attaches counts, splits by whether any applicant email is
      // still pending, and paginates the resulting in-memory list — a real
      // cost, but only paid when this specific filter is in use, and this
      // page's dataset (compliance runs, not applicants) stays small enough
      // for that to be fine.
      if (emailStatusFilter === 'pending' || emailStatusFilter === 'success') {
        const allRows = await ComplianceReportLog.aggregate(pipeline);
        const withCounts = await attachRunCounts(allRows);
        const matches = withCounts.filter((row) => {
          const isPending = (row.counts.applicantReminders.pending || 0) > 0;
          return emailStatusFilter === 'pending' ? isPending : !isPending;
        });

        if (!isPaginationRequested(req.query)) {
          return res.status(200).json(matches);
        }
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const start = (page - 1) * limit;
        return res.status(200).json({ items: matches.slice(start, start + limit), total: matches.length, page, limit });
      }

      if (!isPaginationRequested(req.query)) {
        const rows = await ComplianceReportLog.aggregate(pipeline);
        return res.status(200).json(await attachRunCounts(rows));
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const skip = (page - 1) * limit;

      const [rows, totalResult] = await Promise.all([
        ComplianceReportLog.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
        ComplianceReportLog.aggregate([
          { $match: filter },
          { $group: { _id: { clientId: '$clientId', generatedAt: '$generatedAt' } } },
          { $count: 'total' },
        ]),
      ]);
      const total = totalResult[0]?.total || 0;
      return res.status(200).json({ items: await attachRunCounts(rows), total, page, limit });
    }

    // Sorting by the client's name means sorting by a field on the referenced
    // Client document, not on ComplianceReportLog itself — same reasoning
    // (and same aggregation approach) as matchingRuleController's sortBy=client.
    if (req.query.sortBy === 'client') {
      const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
      const pipeline = [
        { $match: filter },
        { $lookup: { from: 'clients', localField: 'clientId', foreignField: '_id', as: 'client' } },
        { $unwind: { path: '$client', preserveNullAndEmptyArrays: true } },
        { $sort: { 'client.name': sortDir, generatedAt: -1 } },
        { $project: Object.fromEntries(projection.split(' ').map((f) => [f, 1]).concat([['client', 1]])) },
      ];

      if (!isPaginationRequested(req.query)) {
        const rows = await ComplianceReportLog.aggregate(pipeline);
        return res.status(200).json(rows.map(toClientShape));
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const skip = (page - 1) * limit;

      const [rows, totalResult] = await Promise.all([
        ComplianceReportLog.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
        ComplianceReportLog.aggregate([...pipeline, { $count: 'total' }]),
      ]);
      const total = totalResult[0]?.total || 0;
      return res.status(200).json({ items: rows.map(toClientShape), total, page, limit });
    }

    const sortFields = {
      generatedAt: 'generatedAt',
      reportType: 'reportType',
      success: 'success',
      totalEmployees: 'totalEmployees',
      completedCount: 'completedCount',
      incompleteCount: 'incompleteCount',
    };
    const query = ComplianceReportLog.find(filter).select(projection).populate('clientId', 'name');
    const result = await paginate(query, ComplianceReportLog, filter, req.query, {
      sortFields,
      defaultSort: { generatedAt: -1 },
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

// Downloads ONE SPECIFIC historical log's file by its own _id — unlike
// downloadComplianceReport (which always serves the latest successful report
// of a type for a client), this always serves the exact log requested, even
// if newer reports exist for the same client/type since. Left entirely
// separate rather than reusing/branching the existing endpoint, per the task.
const downloadComplianceReportById = async (req, res, next) => {
  try {
    const log = await ComplianceReportLog.findById(req.params.logId).lean();
    if (!log || !log.filePath) {
      return res.status(404).json({ error: 'No file available for this report log.' });
    }

    const buffer = await downloadDropboxFileBuffer(log.filePath);
    const fileName = path.basename(log.filePath);

    res.setHeader('Content-Type', XLSX_MIME_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};

const formatDateUTC = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
};

// Parsed fresh from Dropbox on every request — no caching/persistence, since
// this is meant to reflect exactly whatever file the log actually points to
// right now. Reads the "All Applications" sheet, which already contains
// every employee regardless of week or completed/incomplete status; the
// "Completed Applications"/"Incomplete Applications" sheets are just filtered
// views of the same rows generated at report time, so there's no need to
// touch them here.
const getComplianceReportLogEmployees = async (req, res, next) => {
  try {
    const log = await ComplianceReportLog.findById(req.params.logId).lean();
    if (!log || !log.filePath) {
      return res.status(404).json({ error: 'No file available for this report log.' });
    }

    const buffer = await downloadDropboxFileBuffer(log.filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets['All Applications'];
    if (!sheet) {
      return res.status(404).json({ error: 'This report file has no "All Applications" sheet.' });
    }

    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const includeStatusAndNotes = log.reportType === 'Admin';

    const weekParam = String(req.query.week || 'total').trim();
    const wantsTotal = !weekParam || weekParam.toLowerCase() === 'total';
    const targetWeekLabel = wantsTotal ? null : formatDateUTC(new Date(weekParam));

    const rows = rawRows
      .filter((row) => wantsTotal || String(row['W/E Period'] || '') === targetWeekLabel)
      .map((row) => {
        const shaped = {
          startDate: row['Start Date'] || '',
          employeeName: row['Employee Name'] || '',
          ssn: row['SSN'] || '',
          email: row['Email'] || '',
          completed: row['Completed'] === 'Y',
          weekEndingPeriod: row['W/E Period'] || '',
        };
        if (includeStatusAndNotes) {
          shaped.status = row['Status'] || '';
          shaped.notes = row['Notes'] || '';
        }
        return shaped;
      });

    if (!isPaginationRequested(req.query)) {
      return res.status(200).json(rows);
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const items = rows.slice(skip, skip + limit);

    res.status(200).json({ items, total: rows.length, page, limit });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  generateReports,
  getGenerateReportsStatus,
  getActiveGenerateStatus,
  getComplianceReportStatus,
  downloadComplianceReport,
  getComplianceReportHistory,
  downloadComplianceReportById,
  getComplianceReportLogEmployees,
};
