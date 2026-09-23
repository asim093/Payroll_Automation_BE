const fs = require('fs');
const os = require('os');
const path = require('path');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { findLatestPayrollFile, downloadDropboxFileToLocal, uploadReportFile } = require('./dropboxService');
const { parsePayrollFile } = require('./payrollFileParserService');
const { calculateComplianceStatus, summarizeByWeek } = require('./complianceCalculationService');
const { generateAdminReport, generateClientReport, saveReportToFile } = require('./complianceReportGeneratorService');
const { createComplianceReportDraft } = require('./complianceEmailDraftService');
const { upsertFromComplianceRun } = require('./applicantReminderService');
const { upsertCustomerReportEmailFromRun } = require('./customerReportEmailService');
const { getSettings } = require('./settingsService');
const { getIngestStatus, fetchLogiFormsDataForClient } = require('./logiFormsIngestService');
const { applyMergeFields } = require('../utils/applyMergeFields');
const { formatError } = require('../utils/formatError');

const COMPLIANCE_REPORTS_SUBFOLDER = 'Compliance Reports';
const PAYROLL_FILES_SUFFIX = '/Payroll Files';
const DEFAULT_SUBJECT_TEMPLATE = 'Compliance Report - {{Client Name}}';
const DEFAULT_BODY_TEMPLATE = '{{Salutation}}\n\nPlease find attached the compliance report for this period.';

// TEMPORARY (Part 6 of the Customer Emails build-out): keeps the old
// immediate-Outlook-draft behavior around, fully intact and reachable by
// flipping this one constant, so it can be compared side-by-side against the
// new staging-row flow before being deleted for good. Leave this false.
const USE_LEGACY_DIRECT_DRAFT = false;

// Matches the original VBA source: clients whose dropboxPath points AT their
// "Payroll Files" folder get reports uploaded as a SIBLING of that folder
// (.../Payroll Files stripped, then /Compliance Reports appended), not
// nested inside it. Clients without that suffix (e.g. MSG Staffing, Inc)
// keep dropboxPath as-is.
const resolveReportsFolderSegment = (dropboxPath) => {
  const basePath = dropboxPath.endsWith(PAYROLL_FILES_SUFFIX)
    ? dropboxPath.slice(0, -PAYROLL_FILES_SUFFIX.length)
    : dropboxPath;
  return `${basePath}/${COMPLIANCE_REPORTS_SUBFOLDER}`;
};

// Defense-in-depth: complianceReportController.js's generateReports already
// checks this before creating a job (so a request made during ingestion gets
// an immediate 409 with zero job created), but ingestion can also START
// mid-batch for a multi-client run already in progress — this second check
// catches that case too, surfacing as a normal per-client failure result
// rather than corrupting a report with a half-swapped LogiForms collection.
const assertLogiFormsNotIngesting = async () => {
  const ingestStatus = await getIngestStatus();
  if (ingestStatus?.status === 'ingesting') {
    const error = new Error(
      'Compliance report generation is temporarily paused — a new LogiForms data file is currently being processed. This usually takes up to 10 minutes. Please try again shortly.'
    );
    error.statusCode = 409;
    throw error;
  }
};

const logFailure = async (clientId, error) => {
  try {
    await ComplianceReportLog.create({
      clientId,
      generatedAt: new Date(),
      reportType: 'Admin',
      success: false,
      errorMessage: error.message,
    });
  } catch (logError) {
    console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Failed to write failure log for client ${clientId}: ${formatError(logError)}`);
  }
};

// LogiForms data now comes from a single indexed query against the
// LogiFormsRecord collection (kept current by the hourly/daily ingest
// cron — see logiFormsIngestService.js) instead of downloading and parsing
// the full ~758K-line ShareFile export on every generation. This function no
// longer touches ShareFile at all; only the ingest cron does.
const generateComplianceReportForClient = async (clientId) => {
  let tempDir = null;
  let client = null;

  try {
    await assertLogiFormsNotIngesting();
    client = await Client.findById(clientId);
    if (!client) {
      throw new Error(`Client not found: ${clientId}`);
    }
    if (!client.dropboxPath) {
      throw new Error(`Client "${client.name}" has no dropboxPath configured.`);
    }
    if (!client.fein) {
      throw new Error(`Client "${client.name}" has no FEIN configured.`);
    }

    const latestFile = await findLatestPayrollFile(client.dropboxPath, client.dropboxPathIsAbsolute);
    if (!latestFile) {
      throw new Error(`No payroll file found in Dropbox folder for client "${client.name}" (${client.dropboxPath}).`);
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-report-'));
    const localPayrollPath = path.join(tempDir, latestFile.name);
    await downloadDropboxFileToLocal(latestFile.path, localPayrollPath);

    const payrollRecords = await parsePayrollFile(localPayrollPath);

    const fetched = await fetchLogiFormsDataForClient(client.fein);
    const logiFormsData = fetched.records;
    const logiFormsSkippedRows = fetched.skippedRows;
    const logiFormsRelevantSkippedRows = fetched.relevantSkippedRows;
    const logiFormsUnattributableSkippedRows = fetched.unattributableSkippedRows;

    if (logiFormsRelevantSkippedRows.length > 0 || logiFormsUnattributableSkippedRows.length > 0) {
      console.warn(
        `[LOGIFORMS-PARSE] Data quality notice (not a failure) for client "${client.name}": ${logiFormsSkippedRows.length} row(s) skipped file-wide, ${logiFormsRelevantSkippedRows.length} of those belong to this client's FEIN (${client.fein}), ${logiFormsUnattributableSkippedRows.length} could not be attributed to any client's FEIN — report generated correctly using all other valid rows.`
      );
    }

    const calculatedRecords = await calculateComplianceStatus(payrollRecords, logiFormsData);
    const weeklyStats = summarizeByWeek(calculatedRecords);

    const adminWorkbook = generateAdminReport(client.name, calculatedRecords, weeklyStats);
    const clientWorkbook = generateClientReport(client.name, calculatedRecords, weeklyStats);

    const [adminLocalPath, clientLocalPath] = await Promise.all([
      saveReportToFile(adminWorkbook, tempDir, 'Compliance Report Admin'),
      saveReportToFile(clientWorkbook, tempDir, `Compliance Report ${client.name}`),
    ]);

    const reportsFolderSegment = resolveReportsFolderSegment(client.dropboxPath);
    const [uploadedAdminPath, uploadedClientPath] = await Promise.all([
      uploadReportFile(
        reportsFolderSegment,
        path.basename(adminLocalPath),
        fs.readFileSync(adminLocalPath),
        client.dropboxPathIsAbsolute
      ),
      uploadReportFile(
        reportsFolderSegment,
        path.basename(clientLocalPath),
        fs.readFileSync(clientLocalPath),
        client.dropboxPathIsAbsolute
      ),
    ]);

    const totalEmployees = calculatedRecords.length;
    const completedCount = calculatedRecords.filter((record) => record.isComplete).length;
    const incompleteCount = totalEmployees - completedCount;
    const duplicateSsnCount = calculatedRecords.filter((record) => record.duplicateSsnGroupSize > 1).length;

    // The Client-type log is created before the email step (reversed from
    // the historical order) because the new staging path needs this log's
    // own _id to link the CustomerReportEmail row back to the exact run it
    // came from. emailStatus is filled in afterward and saved once known.
    const generatedAt = new Date();
    const clientReportLog = await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt,
      reportType: 'Client',
      filePath: uploadedClientPath,
      sourcePayrollFileName: latestFile.name,
      sourcePayrollFilePath: latestFile.path,
      totalEmployees,
      completedCount,
      incompleteCount,
      duplicateSsnCount,
      success: true,
      // Same weeklyStats array already computed above and passed into both
      // XLSX builders — persisted on both log types so the drill-down
      // accordion can show real per-week rows for Client logs too, not just
      // a Total-only fallback.
      weeklyBreakdown: weeklyStats,
    });

    let emailStatus = 'Skipped-No-Email';
    if (USE_LEGACY_DIRECT_DRAFT) {
      // ORIGINAL immediate-Outlook-draft path — kept intact (not just
      // described in a comment) so Part 6 can compare it side-by-side
      // against the new staging flow before it's deleted for good.
      // Unreachable while USE_LEGACY_DIRECT_DRAFT is false.
      if (client.complianceReportEmailDistribution) {
        try {
          const { complianceReportEmailTemplate } = await getSettings();
          const subjectTemplate = complianceReportEmailTemplate?.subject?.trim() || DEFAULT_SUBJECT_TEMPLATE;
          const bodyTemplate = complianceReportEmailTemplate?.body?.trim() || DEFAULT_BODY_TEMPLATE;
          const mergeValues = {
            'Client Name': client.name || '',
            'WOTC Form URL': client.wotcFormUrl || '',
            'Salutation': client.emailSalutation || '',
          };

          await createComplianceReportDraft(
            client.complianceReportEmailDistribution,
            clientLocalPath,
            applyMergeFields(subjectTemplate, mergeValues),
            applyMergeFields(bodyTemplate, mergeValues)
          );
          emailStatus = 'Draft-Created';
        } catch (emailError) {
          console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Draft creation failed for client "${client.name}": ${formatError(emailError)}`);
          emailStatus = 'Failed';
        }
      }
    } else {
      // NEW: stage a CustomerReportEmail row instead of drafting immediately
      // — an operator reviews and chooses Draft/Send from the Customer
      // Emails page. emailStatus is derived from the staged row's outcome so
      // ComplianceReportLog.emailStatus keeps meaning "is there an email
      // action item for this run" for dashboards, same as before.
      try {
        const { row } = await upsertCustomerReportEmailFromRun({
          client,
          complianceReportLog: clientReportLog,
          reportFilePath: uploadedClientPath,
        });
        emailStatus = row.status === 'skipped_no_email' ? 'Skipped-No-Email' : 'Draft-Created';
      } catch (stagingError) {
        console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Customer report email staging failed for client "${client.name}": ${formatError(stagingError)}`);
        emailStatus = 'Failed';
      }
    }

    clientReportLog.emailStatus = emailStatus;
    await clientReportLog.save();

    const adminReportLog = await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt,
      reportType: 'Admin',
      filePath: uploadedAdminPath,
      sourcePayrollFileName: latestFile.name,
      sourcePayrollFilePath: latestFile.path,
      totalEmployees,
      completedCount,
      incompleteCount,
      duplicateSsnCount,
      emailStatus,
      success: true,
      weeklyBreakdown: weeklyStats,
    });

    try {
      const reminderResult = await upsertFromComplianceRun(client._id, new Date(), calculatedRecords, adminReportLog._id);
      console.log(
        `[COMPLIANCE-REPORT-ORCHESTRATOR] Applicant reminder queue for "${client.name}": ${JSON.stringify(reminderResult)}`
      );
    } catch (reminderError) {
      console.error(
        `[COMPLIANCE-REPORT-ORCHESTRATOR] Applicant reminder queue upsert failed for "${client.name}" (compliance report still succeeded): ${formatError(reminderError)}`
      );
    }

    return {
      success: true,
      clientId: client._id,
      clientName: client.name,
      totalEmployees,
      completedCount,
      incompleteCount,
      duplicateSsnCount,
      emailStatus,
      logiFormsSkippedRows,
      logiFormsSkippedRowsForClient: logiFormsRelevantSkippedRows.length,
      logiFormsSkippedRowsUnattributable: logiFormsUnattributableSkippedRows.length,
    };
  } catch (error) {
    console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Failed for client ${clientId}: ${formatError(error)}`);
    await logFailure(clientId, error);
    return { success: false, clientId, clientName: client?.name || null, error: error.message };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
};

const DEFAULT_GENERATION_CONCURRENCY = 1;

// Bounded-concurrency worker pool: at most `concurrency` clients are ever
// being generated at once (kept low deliberately — every client's run can
// end with a Graph draft created in the SAME single connected mailbox, so
// concurrency stays modest to avoid bursting that one mailbox's rate limit).
// Each client now runs its own cheap indexed LogiForms query independently
// (see fetchLogiFormsDataForClient in logiFormsIngestService.js) — there is
// no shared file-wide fetch to coordinate any more, since a single query is
// on the order of ~100ms rather than the ~150-170s a full-file parse used to
// cost. Results are returned in the original submission order regardless of
// completion order; onResult (optional) fires as each client finishes.
const generateComplianceReportsForMultipleClients = async (
  clientIds,
  { concurrency = DEFAULT_GENERATION_CONCURRENCY, onResult, onLogiFormsWarnings } = {}
) => {
  await assertLogiFormsNotIngesting();

  // File-wide skipped-row warnings for the job as a whole (Part 1(b)) — read
  // once from the ingest status doc rather than re-parsing anything.
  if (onLogiFormsWarnings) {
    const ingestStatus = await getIngestStatus();
    if (ingestStatus?.skippedRows?.length > 0) {
      onLogiFormsWarnings(ingestStatus.skippedRows);
    }
  }

  const results = new Array(clientIds.length);
  let nextIndex = 0;

  const runWorker = async () => {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= clientIds.length) return;

      const result = await generateComplianceReportForClient(clientIds[currentIndex]);
      results[currentIndex] = result;
      if (onResult) onResult(result);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, clientIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
};

module.exports = { generateComplianceReportForClient, generateComplianceReportsForMultipleClients };
