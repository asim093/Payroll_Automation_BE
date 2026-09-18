const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { generateComplianceReportForClient } = require('../services/complianceReportOrchestratorService');
const { downloadDropboxFileBuffer } = require('../services/dropboxService');
const { paginate, isPaginationRequested } = require('../utils/paginate');
const { createJob, getJob, recordResult } = require('../services/complianceReportGenerationJobs');

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

  const jobId = createJob(clientIds);
  res.json({ success: true, jobId });

  (async () => {
    for (const clientId of clientIds) {
      try {
        const result = await generateComplianceReportForClient(clientId);
        recordResult(jobId, result);
      } catch (error) {
        console.error(`[COMPLIANCE-REPORTS] generateComplianceReportForClient rejected unexpectedly for ${clientId}: ${error.message}`);
        recordResult(jobId, { success: false, clientId, error: error.message });
      }
    }
  })();
};

const getGenerateReportsStatus = (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have already expired).' });
  }
  res.json({
    jobId: job.jobId,
    total: job.total,
    completed: job.completed,
    done: job.done,
    results: job.results,
  });
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
    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const projection =
      'generatedAt clientId reportType success totalEmployees completedCount incompleteCount emailStatus errorMessage filePath weeklyBreakdown';

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
            adminLogId: '$adminLog._id',
            clientLogId: '$clientLog._id',
          },
        },
      ];

      if (!isPaginationRequested(req.query)) {
        const rows = await ComplianceReportLog.aggregate(pipeline);
        return res.status(200).json(rows);
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
      return res.status(200).json({ items: rows, total, page, limit });
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

    res.status(200).json(rows);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  generateReports,
  getGenerateReportsStatus,
  getComplianceReportStatus,
  downloadComplianceReport,
  getComplianceReportHistory,
  downloadComplianceReportById,
  getComplianceReportLogEmployees,
};
