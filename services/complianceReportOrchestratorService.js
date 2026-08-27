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
const { formatError } = require('../utils/formatError');

const COMPLIANCE_REPORTS_SUBFOLDER = 'Compliance Reports';

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

    const latestFile = await findLatestPayrollFile(client.dropboxPath);
    if (!latestFile) {
      throw new Error(`No payroll file found in Dropbox folder for client "${client.name}" (${client.dropboxPath}).`);
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-report-'));
    const localPayrollPath = path.join(tempDir, latestFile.name);
    await downloadDropboxFileToLocal(latestFile.path, localPayrollPath);

    const payrollRecords = await parsePayrollFile(localPayrollPath);

    const logiFormsData = await fetchLogiFormsDataForClient(
      client.fein,
      process.env.LOGIFORMS_API_URL,
      process.env.LOGIFORMS_API_KEY
    );

    const calculatedRecords = await calculateComplianceStatus(payrollRecords, logiFormsData);
    const weeklyStats = summarizeByWeek(calculatedRecords);

    const adminWorkbook = generateAdminReport(client.name, calculatedRecords, weeklyStats);
    const clientWorkbook = generateClientReport(client.name, calculatedRecords, weeklyStats);

    const adminLocalPath = await saveReportToFile(adminWorkbook, tempDir, `Compliance Report ${client.name} (Admin)`);
    const clientLocalPath = await saveReportToFile(clientWorkbook, tempDir, `Compliance Report ${client.name} (Client)`);

    const reportsFolderSegment = `${client.dropboxPath}/${COMPLIANCE_REPORTS_SUBFOLDER}`;
    const uploadedAdminPath = await uploadReportFile(
      reportsFolderSegment,
      path.basename(adminLocalPath),
      fs.readFileSync(adminLocalPath)
    );
    const uploadedClientPath = await uploadReportFile(
      reportsFolderSegment,
      path.basename(clientLocalPath),
      fs.readFileSync(clientLocalPath)
    );

    let emailStatus = 'Skipped-No-Email';
    if (client.complianceReportEmailDistribution) {
      try {
        await createComplianceReportDraft(
          client.complianceReportEmailDistribution,
          client.emailSalutation || client.name,
          clientLocalPath,
          `Compliance Report - ${client.name}`,
          'Please find attached the compliance report for this period.'
        );
        emailStatus = 'Draft-Created';
      } catch (emailError) {
        console.error(`[COMPLIANCE-REPORT-ORCHESTRATOR] Draft creation failed for client "${client.name}": ${formatError(emailError)}`);
        emailStatus = 'Failed';
      }
    }

    const totalEmployees = calculatedRecords.length;
    const completedCount = calculatedRecords.filter((record) => record.isComplete).length;
    const incompleteCount = totalEmployees - completedCount;

    await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt: new Date(),
      reportType: 'Admin',
      filePath: uploadedAdminPath,
      totalEmployees,
      completedCount,
      incompleteCount,
      emailStatus,
      success: true,
    });
    await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt: new Date(),
      reportType: 'Client',
      filePath: uploadedClientPath,
      totalEmployees,
      completedCount,
      incompleteCount,
      emailStatus,
      success: true,
    });

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
