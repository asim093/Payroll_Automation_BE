const fs = require('fs');
const os = require('os');
const path = require('path');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { findLatestPayrollFile, downloadDropboxFileToLocal, uploadReportFile } = require('./dropboxService');
const { parsePayrollFile } = require('./payrollFileParserService');
const { fetchLogiFormsDataForClient } = require('./logiFormsService');
const { calculateComplianceStatus, summarizeByWeek } = require('./complianceCalculationService');
const { generateAdminReport, generateClientReport, saveReportToFile } = require('./complianceReportGeneratorService');
const { createComplianceReportDraft } = require('./complianceEmailDraftService');
const { upsertFromComplianceRun } = require('./applicantReminderService');
const { upsertCustomerReportEmailFromRun } = require('./customerReportEmailService');
const { getSettings } = require('./settingsService');
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

const generateComplianceReportForClient = async (clientId) => {
  let tempDir = null;

  try {
    const client = await Client.findById(clientId);
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

    const logiFormsData = await fetchLogiFormsDataForClient(client.fein);

    const calculatedRecords = await calculateComplianceStatus(payrollRecords, logiFormsData);
    const weeklyStats = summarizeByWeek(calculatedRecords);

    const adminWorkbook = generateAdminReport(client.name, calculatedRecords, weeklyStats);
    const clientWorkbook = generateClientReport(client.name, calculatedRecords, weeklyStats);

    const adminLocalPath = await saveReportToFile(adminWorkbook, tempDir, 'Compliance Report Admin');
    const clientLocalPath = await saveReportToFile(clientWorkbook, tempDir, `Compliance Report ${client.name}`);

    const reportsFolderSegment = resolveReportsFolderSegment(client.dropboxPath);
    const uploadedAdminPath = await uploadReportFile(
      reportsFolderSegment,
      path.basename(adminLocalPath),
      fs.readFileSync(adminLocalPath),
      client.dropboxPathIsAbsolute
    );
    const uploadedClientPath = await uploadReportFile(
      reportsFolderSegment,
      path.basename(clientLocalPath),
      fs.readFileSync(clientLocalPath),
      client.dropboxPathIsAbsolute
    );

    const totalEmployees = calculatedRecords.length;
    const completedCount = calculatedRecords.filter((record) => record.isComplete).length;
    const incompleteCount = totalEmployees - completedCount;

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
      totalEmployees,
      completedCount,
      incompleteCount,
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

    await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt,
      reportType: 'Admin',
      filePath: uploadedAdminPath,
      totalEmployees,
      completedCount,
      incompleteCount,
      emailStatus,
      success: true,
      weeklyBreakdown: weeklyStats,
    });

    try {
      const reminderResult = await upsertFromComplianceRun(client._id, new Date(), calculatedRecords);
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
      emailStatus,
    };
  } catch (error) {
    console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Failed for client ${clientId}: ${formatError(error)}`);
    await logFailure(clientId, error);
    return { success: false, clientId, error: error.message };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
};

const generateComplianceReportsForMultipleClients = async (clientIds) => {
  const results = [];
  for (const clientId of clientIds) {
    const result = await generateComplianceReportForClient(clientId);
    results.push(result);
  }
  return results;
};

module.exports = { generateComplianceReportForClient, generateComplianceReportsForMultipleClients };
